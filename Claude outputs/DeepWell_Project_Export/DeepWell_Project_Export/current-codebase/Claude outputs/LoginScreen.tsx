import { SignIn } from '@clerk/clerk-react';

export function LoginScreen() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">DeepWell</h1>
          <p className="text-slate-400">Equipment Intelligence for HVAC</p>
        </div>

        <div className="bg-slate-800/50 backdrop-blur-sm rounded-lg border border-slate-700/50 shadow-2xl p-8">
          <SignIn
            routing="hash"
            redirectUrl="/"
            appearance={{
              elements: {
                formButtonPrimary: 'bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded-lg w-full transition-colors',
                card: 'bg-transparent',
                headerTitle: 'text-white text-xl font-bold',
                headerSubtitle: 'text-slate-400',
                socialButtonsBlockButton: 'border-slate-600 text-slate-300 hover:bg-slate-700/50',
                formFieldInput: 'bg-slate-700/50 border-slate-600 text-white placeholder:text-slate-500',
                formFieldLabel: 'text-slate-300',
              },
            }}
          />
        </div>

        <p className="text-center text-slate-500 text-sm mt-6">
          Sign in to access your records and documents
        </p>
      </div>
    </div>
  );
}
