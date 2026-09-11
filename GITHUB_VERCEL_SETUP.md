# 🚀 DeepWell - GitHub + Vercel Setup Guide

## Step 1: Create a GitHub Repository

1. Go to **github.com** → Click "+" → "New repository"
2. Name it: `deepwell-prototype`
3. Description: "HVAC Document Management Prototype"
4. **Public** or **Private** (your choice)
5. Click "Create repository"

---

## Step 2: Push Code to GitHub

Open Terminal/Command Prompt and run:

```bash
cd /path/to/deepwell-prototype

# Initialize git
git init

# Add all files
git add .

# Create first commit
git commit -m "Initial commit: Complete HVAC prototype with 10 screens"

# Add your GitHub repo as remote
# Replace YOUR-USERNAME with your GitHub username
git remote add origin https://github.com/YOUR-USERNAME/deepwell-prototype.git

# Push to GitHub
git branch -M main
git push -u origin main
```

---

## Step 3: Deploy to Vercel (1 Click!)

### Option A: Auto-Deploy from GitHub (EASIEST)

1. Go to **vercel.com** (logged in)
2. Click "Add New..." → "Project"
3. Click "Import Git Repository"
4. Paste: `https://github.com/YOUR-USERNAME/deepwell-prototype`
5. Click "Import"
6. Vercel auto-detects Next.js/Vite → Click "Deploy"
7. **Done!** 🎉 Get your live URL in 2 minutes

### Option B: CLI Deploy

```bash
cd deepwell-prototype
vercel --prod
```

---

## After Deployment

### Your Live URL Will Be:
```
https://deepwell-prototype-YOUR-NAME.vercel.app
```

### Update in Real-Time:
Any git push to main = automatic redeploy

```bash
# Make changes locally
git add .
git commit -m "Update features"
git push origin main
# Vercel redeploys automatically! ✨
```

---

## ✅ All Set!

- **GitHub Repo**: `github.com/YOUR-USERNAME/deepwell-prototype`
- **Live Prototype**: `vercel.app/your-project`
- **Access Anytime**: Just visit the Vercel URL

---

## 📋 Files Included

✅ Complete React app (TypeScript)  
✅ 10 fully functional screens  
✅ Mock dataset (12 technicians, 15 equipment)  
✅ Sample files for testing  
✅ Production-ready build  
✅ All documentation  

---

## 🎯 Next Steps

1. **Create GitHub repo** (empty repo)
2. **Push code** using commands above
3. **Connect to Vercel** (1-click import)
4. **Share the live URL** with stakeholders
5. **Make updates** via git push

---

## Support

If you get stuck:
- **GitHub Help**: docs.github.com
- **Vercel Docs**: vercel.com/docs
- **Vite Build**: Check `npm run build` output

---

**You're ready to go live! 🚀**

Questions? The prototype is fully self-contained — no backend setup needed.
