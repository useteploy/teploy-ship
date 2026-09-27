export async function calculate(baseURL, a, b, request = fetch) {
  const response = await request(new URL('/add', baseURL), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a, b }),
  });
  if (!response.ok) throw new Error(`Arithmetic API returned ${response.status}`);
  const data = await response.json();
  if (!Number.isFinite(data.result)) throw new Error('Arithmetic API returned an invalid result');
  return data.result;
}
