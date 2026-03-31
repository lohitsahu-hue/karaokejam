// Generate a human-friendly room code (e.g., "KRK-4A7B")
function generateRoomCode(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code.slice(0, 3) + '-' + code.slice(3);
}

module.exports = { generateRoomCode };