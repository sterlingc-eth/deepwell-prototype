"""Fit the learned VERIFIER for the shipped CPU reader and export data/verifier.json (+ the JS/Python parity fixture).

  node scripts/learned-reader/score-top5.mjs dev-bank7.jsonl.gz labels.json /tmp/cpu_scores      # top-5 per head of the shipped model on dev
  python scripts/learned-reader/fit_verifier.py /tmp/cpu_scores OUT_DIR [split.json]

Method (from the training kit's experiments, R1): per-head temperature, a width-30 beam over the nine heads, 300 shallow LightGBM trees on the
confidence features; the verifier is fitted only on rows the reader could answer (no <OTHER>, skeleton seen in data/trsk.bin), tenant-grouped
5-fold out-of-fold scores give the thresholds (Clopper-Pearson one-sided 95%). Refit whenever data/model-cpu.bin changes.
needs: numpy scipy scikit-learn lightgbm. conf_lib.py is the kit's confidence library."""
import sys,os,json,zlib,numpy as np,lightgbm as lgb
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__))); from conf_lib import *
from sklearn.model_selection import GroupKFold
HERE=os.path.dirname(os.path.abspath(__file__)); DATA=os.path.join(HERE,'../../api/_lib/dql/reader-ml/data')
prefix,outd=sys.argv[1:3]; split=json.load(open(sys.argv[3])) if len(sys.argv)>3 else None; os.makedirs(outd,exist_ok=True)
b=open(prefix+'.bin','rb').read(); m=json.load(open(prefix+'.json')); n=m['n']; o=0
def take(dt,cnt,shape):
    global o; a=np.frombuffer(b,dt,cnt,o).reshape(shape); o+=a.nbytes; return a
TI=take(np.int32,n*45,(n,9,5)); TP=take(np.float32,n*45,(n,9,5)); ENT=take(np.float32,n*9,(n,9)); Y=take(np.int32,n*9,(n,9)); QM=take(np.float64,n*9,(n,9)); g=np.array(m['g']); ten=np.array(m['t'])
cls=json.loads(zlib.decompress(open(DATA+'/classes.json.gz','rb').read(),31)); SEEN=set(np.frombuffer(open(DATA+'/trsk.bin','rb').read(),'<u8').tolist())
def seen_of(lab):
    out=np.zeros(len(lab),bool)
    for i,l in enumerate(lab):
        bb='\x1f'.join('\x00' if cls[h][int(l[j])] is None else cls[h][int(l[j])] for j,h in enumerate(H)).encode('utf8')
        out[i]=((zlib.crc32(bb,0x1234abcd)<<32)|zlib.crc32(bb,0x9e3779b9)) in SEEN
    return out
def beam(Q,K=30):
    """width-K beam over the nine heads on tempered log-probabilities; ties break by candidate order (stable), exactly like api/_lib/dql/reader-ml/verifier.mjs"""
    n=Q.shape[0]; L=np.log(np.clip(Q,1e-12,1)); sc=np.zeros((n,1)); cb=np.zeros((n,1,0),np.int64)
    for j in range(9):
        k=sc.shape[1]; cand=(sc[:,:,None]+L[:,j,None,:]).reshape(n,-1); kk=min(K,cand.shape[1]); ix=np.argsort(-cand,axis=1,kind='stable')[:,:kk]
        sc=np.take_along_axis(cand,ix,1); bi=ix//5; ni=ix%5
        cb=np.concatenate([np.take_along_axis(cb,bi[:,:,None].repeat(cb.shape[2],2),1),ni[:,:,None]],2)
    return cb,sc
def feats(TI,TP,ENT,T,K=30):
    Q,_=tempered(TP,T); cb,bsc=beam(Q,K); lab=np.take_along_axis(TI[:,None,:,:].repeat(K,1),cb[:,:,:,None],3)[:,:,:,0]
    p2,c2,gap,nv,_,ok=rescore(bsc,lab,np.zeros(bsc.shape,np.float32),0.0); raw=TP[:,:,0]; margin=raw-TP[:,:,1]
    F=np.hstack([raw,margin,ENT,Q[:,:,0],np.log(np.clip(raw.prod(1),1e-12,1))[:,None],(TI[:,:,0]==0).sum(1)[:,None],np.log(np.clip(c2,1e-12,1))[:,None],gap[:,None],nv[:,None]]); return F,p2,ok
PRM=dict(objective='binary',learning_rate=0.05,num_leaves=15,min_data_in_leaf=40,feature_fraction=0.8,bagging_fraction=0.8,bagging_freq=1,lambda_l2=5.0,verbose=-1,num_threads=2,seed=3)
def fit(rows):
    T=fit_temps(TI,TP,Y,rows); F,p2,ok=feats(TI,TP,ENT,T); k=ok&np.all(p2==Y,1); gate=ok&seen_of(p2); y=k.astype(int); r=np.zeros(n,bool); r[rows]=True
    oof=np.zeros(n); idx=np.where(gate&r)[0]
    for tr,va in GroupKFold(5).split(idx,y[idx],ten[idx]): oof[idx[va]]=lgb.train(PRM,lgb.Dataset(F[idx[tr]],y[idx[tr]]),300).predict(F[idx[va]])
    return T,F,k,gate,y,oof
names=['raw%d'%i for i in range(9)]+['margin%d'%i for i in range(9)]+['entropy%d'%i for i in range(9)]+['q%d'%i for i in range(9)]+['logjoint','n_other','logpost','gap','nvalid']
if split:
    sel=np.array(split['select_rows']); rep=np.array(split['report_rows'])
    for a,bq,lab in [(sel,rep,'fit SELECT, score REPORT'),(rep,sel,'fit REPORT, score SELECT')]:
        T,F,k,gate,y,oof=fit(a); mdl=lgb.train(PRM,lgb.Dataset(F[a][gate[a]],y[a][gate[a]]),300); s=np.where(gate,mdl.predict(F),0.0)
        e=evaluate(s[bq],k[bq],g[bq],thr_empirical(s[bq],k[bq])); print(lab,'cov@99 (threshold tuned on the scored half): ALL %.1f'%(100*e['ALL']['cov']),{x:round(100*e[x]['cov'],1) for x in GROUPS})
allr=np.arange(n); T,F,k,gate,y,oof=fit(allr)
thr={'cp995':thr_cp(oof,k,0.995),'cp99':thr_cp(oof,k,0.99),'emp995':thr_empirical(oof,k,0.995),'emp99':thr_empirical(oof,k,0.99)}
for nm,t in thr.items(): e=evaluate(oof,k,g,t); print(nm,'thr %.5f'%t,'cov ALL %.1f'%(100*e['ALL']['cov']),'prec %.2f'%(100*(e['ALL']['prec'] or 0)),{x:round(100*e[x]['cov'],1) for x in GROUPS})
mdl=lgb.train(PRM,lgb.Dataset(F[gate],y[gate]),300)
def cut(nd):
    if 'split_index' in nd: return {'split_index':nd['split_index'],'split_feature':nd['split_feature'],'decision_type':nd['decision_type'],'threshold':nd['threshold'],'left_child':cut(nd['left_child']),'right_child':cut(nd['right_child'])}
    return {'leaf_value':nd['leaf_value']}
cfg={'variant':'cpu_heads_beam','note':'verifier for data/model-cpu.bin; fitted on bank-7 dev (22,615 questions, 52 companies); thresholds are on the verifier score','features':names,'temperatures':dict(zip(H,T)),'beam_width':30,
     'thresholds':thr,'threshold':thr['cp995'],'threshold_name':'cp995','tree_dump':{'tree_info':[{'tree_structure':cut(t['tree_structure'])} for t in mdl.dump_model()['tree_info']]}}
json.dump(cfg,open(outd+'/verifier.json','w'),separators=(',',':'),default=float); print('verifier.json bytes',os.path.getsize(outd+'/verifier.json'))
# ---- parity fixture: 500 rows (250 random, 250 nearest the shipped threshold); the reference is float64 numpy beam + the LightGBM booster
rng=np.random.RandomState(11); sc=mdl.predict(F); near=np.argsort(np.abs(sc-thr['cp995']))[:250]; rest=np.setdiff1d(allr,near); pick=np.concatenate([near,rng.choice(rest,250,replace=False)])
TI6,TP6,ENT6=TI[pick],TP[pick].astype(np.float64),ENT[pick].astype(np.float64); F6,p6,ok6=feats(TI6,TP6,ENT6,np.asarray(T,np.float64)); s6=np.where(ok6,mdl.predict(F6),0.0)
cases=[{'top5':[{'ix':TI6[i,j].tolist(),'pv':TP6[i,j].tolist(),'ent':float(ENT6[i,j])} for j in range(9)],'answer':bool(s6[i]>=thr['cp995']),'labels':p6[i].tolist() if ok6[i] else None,'score':float(s6[i])} for i in range(len(pick))]
json.dump({'threshold':thr['cp995'],'cases':cases},open(outd+'/reader-verifier-parity.json','w'),separators=(',',':'),default=float)
print('parity cases',len(cases),'accepted',sum(c['answer'] for c in cases))
