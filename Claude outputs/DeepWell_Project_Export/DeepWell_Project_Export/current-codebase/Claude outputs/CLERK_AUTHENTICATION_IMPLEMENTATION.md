# Clerk Authentication Implementation Guide

## Problem
The VITE_CLERK_PUBLISHABLE_KEY environment variable was added to Vercel, but Clerk authentication wasn't actually implemented in the code. The app still shows the Ask screen without requiring login.

## Solution
Implement Clerk authentication throughout the app to require login before users can access any features.

## Files Modified/Created

### 1. package.json
Add Clerk dependency to the dependencies section:

```json
"@clerk/clerk-react": "^5.3.2",
```

Full section should look like:
```json
"dependencies": {
  "@anthropic-ai/sdk": "^0.24.3",
  "@clerk/clerk-react": "^5.3.2",
  "html2canvas": "^1.4.1",
  "jspdf": "^4.2.1",
  "lucide-react": "^1.43.0",
  "react": "^18.3.1",
  "react-dom": "^18.3.1",
  "react-router-dom": "6.26.0",
  "zustand": "4.5.5"
},
```

### 2. src/main.tsx
Replace entire file with:

```typescript
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import './index.css'
import App from './App.tsx'
import { bootstrapHvac } from './domains/hvac'

bootstrapHvac()

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!clerkPublishableKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY environment variable');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClerkProvider publishableKey={clerkPublishableKey}>
      <App />
    </ClerkProvider>
  </StrictMode>,
)
```

### 3. src/screens/LoginScreen.tsx
Create new file with:

```typescript
import { SignIn } from '@clerk/clerk-react';

export function LoginScreen() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-[#163C2C] to-[#0F2818] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-white font-serif">DeepWell</h1>
          <p className="text-gray-300 mt-2">HVAC Service Intelligence</p>
        </div>
        
        <div className="bg-white rounded-lg shadow-xl p-8">
          <SignIn 
            redirectUrl="/"
            routing="hash"
            appearance={{
              elements: {
                rootBox: "mx-auto",
                card: "shadow-none border-0",
              },
              variables: {
                colorPrimary: "#163C2C",
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}
```

### 4. src/screens/index.ts
Add export for LoginScreen:

```typescript
export { LoginScreen } from './LoginScreen';
```

Full file should be:
```typescript
export { AskScreen } from './AskScreen';
export { EntityScreen } from './EntityScreen';
export { RecordsScreen } from './RecordsScreen';
export { IntakeScreen } from './IntakeScreen';
export { ReviewScreen } from './ReviewScreen';
export { DashboardScreen } from './DashboardScreen';
export { BrowseScreen } from './BrowseScreen';
export { LoginScreen } from './LoginScreen';
```

### 5. src/App.tsx
Add authentication check at the beginning:

Replace the import section:
```typescript
import { lazy, Suspense } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useAppStore } from './store/appStore';
import { AskScreen, BrowseScreen, DashboardScreen, EntityScreen, IntakeScreen, LoginScreen, RecordsScreen, ReviewScreen } from './screens';
import './index.css';
```

And update the App function:
```typescript
function App() {
  const { isSignedIn, isLoaded } = useAuth();
  const currentScreen = useAppStore((s) => s.currentScreen);

  // Show loading screen while authentication is loading
  if (!isLoaded) {
    return <div className="min-h-screen bg-bg" aria-busy="true" />;
  }

  // Show login screen if not authenticated
  if (!isSignedIn) {
    return <LoginScreen />;
  }

  // Rest of the switch statement continues as before...
  switch (currentScreen) {
    // ... rest of code unchanged
  }
}
```

## Next Steps

1. **Make Changes**: Apply the above changes to your local repository
2. **Test Locally**: Run `npm install && npm run dev` to test
3. **Commit**: 
   ```bash
   git add -A
   git commit -m "Add Clerk authentication - shows login screen for unauthenticated users"
   ```
4. **Push to GitHub**:
   ```bash
   git push origin main
   ```
5. **Wait for Vercel Build**: Vercel will automatically detect the push and rebuild with the `VITE_CLERK_PUBLISHABLE_KEY` environment variable injected

## What This Does

- ✅ Shows a login screen when users aren't authenticated
- ✅ Injects the VITE_CLERK_PUBLISHABLE_KEY environment variable during build
- ✅ Prevents access to the Ask screen and other features until logged in
- ✅ Uses Clerk's built-in authentication UI
- ✅ Styled with DeepWell's brand colors (#163C2C forest green)

## Verification

After the Vercel build completes:
1. Go to https://deepwellinc.vercel.app/app/
2. You should see the DeepWell login screen (not the Ask screen)
3. Sign in with your Clerk account credentials
4. After authentication, you'll be redirected to the Ask screen

