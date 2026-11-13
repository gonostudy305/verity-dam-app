async function main() {
  const res = await fetch('http://127.0.0.1:3000/library');
  console.log('Status:', res.status);
  const text = await res.text();
  const match = text.match(/"message":\s*"([^"]+)"/);
  if (match) {
    console.log('Server Error:', match[1]);
  }
  const stackMatch = text.match(/"stack":\s*"([^"]+)"/);
  if (stackMatch) {
    console.log('Stack:', stackMatch[1].replace(/\\n/g, '\n'));
  }
}
main().catch(console.error);
