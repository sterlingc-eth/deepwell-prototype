import { verifyAuth } from '@clerk/nextjs/edge';
import { neon } from '@neondatabase/serverless';

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request) {
  const { isSignedIn, userId } = await verifyAuth(req);
  if (!isSignedIn || !userId) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const sql = neon(process.env.DATABASE_URL!);
  const method = req.method;

  try {
    if (method === 'GET') {
      const expenses = await sql(
        SELECT id, date, category, description, amount, notes, created_at 
         FROM expenses 
         WHERE user_id =  
         ORDER BY date DESC,
        [userId]
      );
      return new Response(JSON.stringify(expenses), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (method === 'POST') {
      const { date, category, description, amount, notes } = await req.json();

      if (!date || !category || !description || amount === undefined) {
        return new Response(
          JSON.stringify({ error: 'Missing required fields' }),
          { status: 400 }
        );
      }

      const result = await sql(
        INSERT INTO expenses (user_id, date, category, description, amount, notes)
         VALUES (, , , , , )
         RETURNING id, date, category, description, amount, notes, created_at,
        [userId, date, category, description, parseFloat(amount), notes || null]
      );

      return new Response(JSON.stringify(result[0]), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (method === 'DELETE') {
      const url = new URL(req.url);
      const expenseId = url.searchParams.get('id');

      if (!expenseId) {
        return new Response(JSON.stringify({ error: 'Missing expense ID' }), { status: 400 });
      }

      const [expense] = await sql(
        SELECT id FROM expenses WHERE id =  AND user_id = ,
        [expenseId, userId]
      );

      if (!expense) {
        return new Response(JSON.stringify({ error: 'Expense not found' }), { status: 404 });
      }

      await sql(DELETE FROM expenses WHERE id = , [expenseId]);

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  } catch (error) {
    console.error('Database error:', error);
    return new Response(JSON.stringify({ error: 'Database operation failed' }), { status: 500 });
  }
}
