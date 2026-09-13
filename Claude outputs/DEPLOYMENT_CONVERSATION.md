# DeepWell Deployment Conversation - Sterling Chapman

**Date:** September 11, 2026
**User:** Sterling Chapman (scchapman94@gmail.com)
**Project:** DeepWell HVAC Prototype

## Summary

Complete deployment of DeepWell prototype from cloud development to Vercel production.

## Key Steps

### 1. GitHub Desktop Setup
- Cloned `deepwell-prototype` repository to Desktop/GitHub
- Extracted codebase files from deepwell-code.tar.gz

### 2. File Structure Issues Fixed
- Initial extraction created nested deepwell-code subfolder
- Moved all files to repository root
- Deleted empty deepwell-code folder

### 3. Vercel Configuration
- Created `vercel.json` with build configuration:
  ```json
  {
    "buildCommand": "npm run build",
    "outputDirectory": "dist",
    "devCommand": "npm run dev"
  }
  ```

### 4. Dependency Resolution
- Fixed React version conflict with Framer Motion
- Downgraded React from 19.2.8 to 18.3.1
- Updated both react and react-dom to ^18.3.1

### 5. Deployment Flow
1. Create GitHub repo: `sterlingc-eth/deepwell-prototype`
2. Clone to local machine
3. Extract source files
4. Organize file structure at repo root
5. Create vercel.json configuration
6. Fix React/Framer Motion compatibility
7. Push to GitHub
8. Import into Vercel dashboard
9. Vercel auto-builds and deploys

## Commands Used

```bash
# Move files to repo root
Move-Item "deepwell-code\*" -Destination "." -Force
Remove-Item "deepwell-code" -Force

# Fix React version
(Get-Content package.json) -replace '"react": ".*?"', '"react": "^18.3.1"' -replace '"react-dom": ".*?"', '"react-dom": "^18.3.1"' | Set-Content package.json

# Commit and push
git add .
git commit -m "Fix folder structure"
git push
```

## Vercel Deployment Details
- **Repository:** github.com/sterlingc-eth/deepwell-prototype
- **Deploy Command:** npm install && npm run build
- **Build Output:** dist/
- **Dev Command:** npm run dev
- **Domains:**
  - deepwell-prototype.vercel.app
  - deepwell-prototype-git-main-chappy420.vercel.app

## DeepWell Features (10 Screens)
1. Document Upload/Ingestion
2. Dashboard with Statistics
3. On-Site Equipment Search (Fuzzy Search)
4. Warranty Tracking
5. Job Dispatch Brief
6. Warranty Export
7. Technician Profiles
8. Equipment Details
9. Extraction Review
10. Home Navigation Hub

## Mock Data
- 12 Technicians
- 15 Equipment Units
- 10 Properties
- 25+ Service Events
- Sample files for testing (work orders, warranties, service records)

## Tech Stack
- React 18.3.1 with TypeScript (strict mode)
- Zustand for state management
- Framer Motion for animations
- Tailwind CSS with dark mode
- Vite build tool
- Production bundle: 359KB gzipped

## Issues Encountered & Solutions

| Issue | Cause | Solution |
|-------|-------|----------|
| npm not in PATH | Node.js not installed locally | Vercel runs npm install automatically |
| git not in PATH | Git not installed locally | Used GitHub Desktop for commits |
| 404 NOT_FOUND | No framework detected | Added vercel.json configuration |
| Files nested | Incorrect extraction | Moved files to repository root |
| npm ERESOLVE error | React 19 incompatible with Framer Motion 11 | Downgraded to React 18.3.1 |

## Vercel Auto-Deploy
After pushing to GitHub, Vercel automatically:
1. Detects push notification
2. Clones repository
3. Installs dependencies (npm install)
4. Runs build command (npm run build)
5. Deploys dist/ folder to CDN
6. Provides live URL

## Project Ready
✅ All 10 screens implemented and functional
✅ Mock data complete
✅ Production build verified
✅ Deployed to Vercel
✅ Live URL accessible

---
**Note:** This conversation documents the complete deployment workflow for future reference.
