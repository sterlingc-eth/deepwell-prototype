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
