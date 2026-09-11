/**
 * Minimal test component - renders only "TEST SUCCESS"
 * This isolates whether React rendering itself works
 */

function TestMinimal() {
  return (
    <div style={{ padding: '20px', fontSize: '24px', fontWeight: 'bold' }}>
      TEST SUCCESS - React Component Rendered
    </div>
  );
}

export default TestMinimal;
