import type { Handler } from '@netlify/functions';
export const handler: Handler = async (event) => {
  console.log('Platform notification headers:', event.headers);
  console.log('Platform notification body:', event.body);
  return { statusCode: 200, body: '' };
};
