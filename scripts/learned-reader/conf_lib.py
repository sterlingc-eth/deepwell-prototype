"""Confidence library for Donovan: per-head temperature, joint top-k rescoring with combo prior, LightGBM verifier, thresholds."""
import json,numpy as np
from scipy.stats import beta
from scipy.optimize import minimize_scalar
H=['op','ent','dt','meas','time','grp','filt','args','rest']
GROUPS=['known','unseen4','unseen5','new7']

def make_split(tenants,groups,seed=7):
    """tenant-level split (new-customer setting), stratified by group: tenants sorted by their majority group, shuffled, alternated"""
    rng=np.random.RandomState(seed); ten=sorted(set(tenants)); maj={}
    for t in ten:
        gs=groups[tenants==t]; u,c=np.unique(gs,return_counts=True); maj[t]=u[c.argmax()]
    fold={}
    for g in sorted(set(maj.values())):
        ts=[t for t in ten if maj[t]==g]; rng.shuffle(ts)
        for k,t in enumerate(ts): fold[t]=k%2      # 0 = SELECT, 1 = REPORT
    return np.array([fold[t] for t in tenants])

def base_pred(TI,TP):
    pred=TI[:,:,0]; ans=np.all(pred!=0,axis=1); conf=np.where(ans,TP[:,:,0].prod(1),0.0); return pred,ans,conf

def tempered(TP,T):
    """top-5 probs + lumped tail, power 1/T per head -> calibrated probs q (n,9,5) and tail"""
    tail=np.clip(1-TP.sum(2),1e-9,1); X=np.concatenate([TP,tail[:,:,None]],2); X=np.clip(X,1e-12,1)**(1.0/np.asarray(T)[None,:,None]); X=X/X.sum(2,keepdims=True)
    return X[:,:,:5],X[:,:,5]

def fit_temps(TI,TP,Y,rows):
    T=[]
    for j in range(9):
        y=Y[rows,j]; ti=TI[rows,j]; hit=(ti==y[:,None]); inside=hit.any(1); pos=hit.argmax(1)
        def nll(lt):
            t=np.exp(lt); tail=np.clip(1-TP[rows,j].sum(1),1e-9,1); X=np.concatenate([TP[rows,j],tail[:,None]],1); X=np.clip(X,1e-12,1)**(1/t); X/=X.sum(1,keepdims=True)
            p=np.where(inside,X[np.arange(len(y)),np.where(inside,pos,0)],X[:,5]/50.0); return -np.log(np.clip(p,1e-12,1)).mean()
        r=minimize_scalar(nll,bounds=(-1.5,2.5),method='bounded'); T.append(float(np.exp(r.x)))
    return T

def beam(Q,K=30):
    """beam search over heads; Q (n,9,5) probabilities of per-head top-5 (idx order = TI order). returns combos idx-in-top5 (n,K,9), logscore (n,K)"""
    n=Q.shape[0]; L=np.log(np.clip(Q,1e-12,1)); sc=L[:,0,:].copy(); cb=np.arange(5)[None,:,None].repeat(n,0)
    for j in range(1,9):
        k=sc.shape[1]; cand=(sc[:,:,None]+L[:,j,None,:]).reshape(n,-1); kk=min(K,cand.shape[1]); ix=np.argpartition(-cand,kk-1,axis=1)[:,:kk]
        s=np.take_along_axis(cand,ix,1); o=np.argsort(-s,1); ix=np.take_along_axis(ix,o,1); s=np.take_along_axis(s,o,1)
        bi=ix//5; ni=ix%5; cb=np.concatenate([np.take_along_axis(cb,bi[:,:,None].repeat(cb.shape[2],2),1),ni[:,:,None]],2); sc=s
    return cb,sc

def combo_lookup(counts,TI,cb):
    n,K,_=cb.shape; lab=np.take_along_axis(TI[:,None,:,:].repeat(K,1),cb[:,:,:,None],3)[:,:,:,0]   # (n,K,9) label idx
    c=np.zeros((n,K),np.float32); get=counts.get
    for i in range(n):
        for k in range(K): c[i,k]=get(tuple(lab[i,k].tolist()),0)
    return lab,c

def rescore(sc,lab,cnt,lam,alpha=1.0):
    """joint posterior over the beam with combo prior (count+alpha)^lam; invalid (any head=<OTHER>) combos get zero mass. returns pred labels, conf, gap, nvalid"""
    valid=np.all(lab!=0,axis=2); s=sc+lam*np.log(cnt+alpha); s=np.where(valid,s,-1e9); mx=s.max(1,keepdims=True); e=np.where(valid,np.exp(s-mx),0); z=e.sum(1)+1e-30
    top=s.argmax(1); n=len(s); post=e[np.arange(n),top]/z; srt=np.sort(s,1)[:,::-1]; gap=np.where(srt[:,1]>-1e8,srt[:,0]-srt[:,1],20.0)
    pred=lab[np.arange(n),top]; ok=valid.any(1); return pred,np.where(ok,post,0.0),gap,valid.sum(1),cnt[np.arange(n),top],ok

def thr_empirical(conf,correct,P=0.99,minn=20):
    idx=np.argsort(-conf,kind='stable'); c=np.cumsum(correct[idx]); n=np.arange(1,len(idx)+1); ok=(c/n>=P)&(n>=minn)&(conf[idx]>0)
    return float(conf[idx][np.where(ok)[0].max()]) if ok.any() else np.inf
def thr_cp(conf,correct,P=0.99,alpha=0.05,minn=20):
    """largest accepted set whose one-sided Clopper-Pearson lower bound on precision >= P"""
    idx=np.argsort(-conf,kind='stable'); c=np.cumsum(correct[idx]); n=np.arange(1,len(idx)+1)
    lo=np.where(c>0,beta.ppf(alpha,c,n-c+1),0.0); ok=(lo>=P)&(n>=minn)&(conf[idx]>0)
    return float(conf[idx][np.where(ok)[0].max()]) if ok.any() else np.inf
def evaluate(conf,correct,g,thr):
    acc=conf>=thr; out={}
    for name,m in [('ALL',np.ones(len(conf),bool))]+[(x,g==x) for x in GROUPS]:
        a=acc&m; out[name]={'cov':float(a.sum()/m.sum()),'prec':float(correct[a].mean()) if a.any() else None,'n':int(m.sum()),'wrong_per_1000':float(1000*(~correct[a]).sum()/m.sum())}
    return out
