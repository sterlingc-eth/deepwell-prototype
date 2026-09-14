import { SignIn } from '@clerk/clerk-react';
import { Wordmark } from '../components/Wordmark';

export function LoginScreen() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-[#163C2C] to-[#0F2818] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <h1 className="m-0">
            <Wordmark size="lg" />
          </h1>
          <p className="text-forest-100 mt-3">Knowledge builds business.</p>
        </div>

        <div className="bg-white rounded-lg shadow-xl p-8">
          <SignIn
            fallbackRedirectUrl="/app/"
            routing="hash"
            appearance={{
              elements: {
                rootBox: 'mx-auto',
                card: 'shadow-none border-0',
              },
              variables: {
                colorPrimary: '#0D3827',
              },
            }}
          />
        </div>
      </div>
    </div>
  );
}
