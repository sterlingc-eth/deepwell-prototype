import { SignIn } from '@clerk/clerk-react';
import { ArrowLeft } from 'lucide-react';
import { Wordmark } from '../components/Wordmark';

/** The plate behind the lockup; the sign-in card matches it. */
const PLATE = '#F6F8F6';

export function LoginScreen() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-[#163C2C] to-[#0F2818] flex flex-col items-center justify-center gap-8 p-4">
      <div className="dw-rise flex flex-col items-center text-center">
        <h1 className="m-0">
          <Wordmark size="lg" animated />
        </h1>
        <p className="text-forest-100 mt-4 text-body-lg">Knowledge Builds Business.</p>
      </div>

      <div
        className="dw-rise dw-rise-late w-full max-w-md rounded-lg shadow-xl p-6 sm:p-8 flex justify-center"
        style={{ background: PLATE }}
      >
        <SignIn
          fallbackRedirectUrl="/app/"
          routing="hash"
          appearance={{
            elements: {
              rootBox: 'w-full flex justify-center',
              cardBox: 'w-full shadow-none border-0',
              card: 'w-full shadow-none border-0 mx-auto',
              formFieldInput: 'w-full',
            },
            variables: {
              colorPrimary: '#0D3827',
              colorBackground: PLATE,
            },
          }}
        />
      </div>

      <a
        href="/"
        className="dw-rise dw-rise-late inline-flex items-center gap-2 min-h-touch px-3 rounded-md text-forest-100 hover:text-stone-0 hover:bg-white/10 transition-colors duration-quick focus-visible:outline-brass-300"
      >
        <ArrowLeft className="w-4 h-4" aria-hidden="true" />
        <span className="text-body">Back to the DeepWell website</span>
      </a>
    </div>
  );
}
