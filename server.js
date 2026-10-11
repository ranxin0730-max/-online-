const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 25000, pingTimeout: 20000 });
const PORT = process.env.PORT || 3000;
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (_req, res) => res.json({ ok: true }));

const rooms = new Map();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
function newPlayer(id, slot) {
  return { id, slot, x: slot === 1 ? 170 : 730, y: 0, vx: 0, vy: 0, hp: 100, energy: 0, facing: slot === 1 ? 1 : -1,
    grounded: true, attack: null, attackCooldown: 0, stun: 0, input: {}, color: slot === 1 ? '#43e8ff' : '#ff4f9a', wins: 0 };
}
function makeRoom(code, hostId) {
  const room = { code, hostId, players: new Map(), status: 'waiting', winner: null, lastTick: Date.now(), tick: null, createdAt: Date.now() };
  rooms.set(code, room); return room;
}
function publicState(room) {
  return { code: room.code, status: room.status, winner: room.winner,
    players: [...room.players.values()].map(p => ({ id: p.id, slot: p.slot, x: p.x, y: p.y, hp: p.hp, energy: p.energy, facing: p.facing, grounded: p.grounded, attack: p.attack ? { type: p.attack.type, age: p.attack.age } : null, stun: p.stun, color: p.color, wins: p.wins })) };
}
function startLoop(room) {
  if (room.tick) clearInterval(room.tick);
  room.tick = setInterval(() => {
    if (!rooms.has(room.code) || room.status !== 'playing') return;
    const now = Date.now(); const dt = Math.min(0.04, Math.max(0.01, (now - room.lastTick) / 1000)); room.lastTick = now;
    const ps = [...room.players.values()];
    for (const p of ps) {
      const inp = p.input || {};
      if (p.stun > 0) p.stun = Math.max(0, p.stun - dt);
      if (p.attackCooldown > 0) p.attackCooldown = Math.max(0, p.attackCooldown - dt);
      if (p.attack) { p.attack.age += dt; if (p.attack.age > p.attack.duration) p.attack = null; }
      if (p.stun <= 0) {
        p.vx = (inp.left ? -1 : 0) + (inp.right ? 1 : 0);
        p.vx *= 260;
        if (inp.jump && p.grounded) { p.vy = -520; p.grounded = false; }
        if (inp.punch && p.attackCooldown <= 0) { p.attack = { type: 'punch', age: 0, duration: 0.25, hit: false }; p.attackCooldown = 0.34; }
        if (inp.kick && p.attackCooldown <= 0) { p.attack = { type: 'kick', age: 0, duration: 0.38, hit: false }; p.attackCooldown = 0.48; }
        if (inp.special && p.energy >= 100 && p.attackCooldown <= 0) { p.attack = { type: 'special', age: 0, duration: 0.58, hit: false }; p.attackCooldown = 0.75; p.energy = 0; }
      } else { p.vx = 0; }
      p.x = clamp(p.x + p.vx * dt, 38, 862);
      if (!p.grounded) { p.vy += 1200 * dt; p.y += p.vy * dt; if (p.y >= 0) { p.y = 0; p.vy = 0; p.grounded = true; } }
    }
    if (ps.length === 2) {
      const [a, b] = ps; a.facing = a.x <= b.x ? 1 : -1; b.facing = b.x <= a.x ? 1 : -1;
      for (const p of ps) {
        if (!p.attack || p.attack.hit) continue;
        const other = p === a ? b : a; const atk = p.attack;
        const active = atk.type === 'punch' ? atk.age >= 0.07 && atk.age <= 0.17 : atk.type === 'kick' ? atk.age >= 0.11 && atk.age <= 0.25 : atk.age >= 0.12 && atk.age <= 0.42;
        if (active) {
          const reach = atk.type === 'punch' ? 90 : atk.type === 'kick' ? 120 : 260;
          const verticalOK = Math.abs(p.y - other.y) < 95;
          if (Math.abs(p.x - other.x) < reach && verticalOK && p.facing === (p.x < other.x ? 1 : -1)) {
            const damage = atk.type === 'punch' ? 7 : atk.type === 'kick' ? 12 : 24;
            other.hp = Math.max(0, other.hp - damage); other.energy = Math.min(100, other.energy + (atk.type === 'special' ? 0 : 18)); p.energy = Math.min(100, p.energy + 12);
            other.stun = atk.type === 'special' ? 0.38 : 0.2; other.x = clamp(other.x + p.facing * (atk.type === 'special' ? 72 : 28), 38, 862); atk.hit = true;
          }
        }
      }
      const dead = ps.find(p => p.hp <= 0);
      if (dead) { room.status = 'finished'; room.winner = dead.slot === 1 ? 2 : 1; const winner = ps.find(p => p.slot === room.winner); if (winner) winner.wins++; io.to(room.code).emit('state', publicState(room)); io.to(room.code).emit('roundOver', { winner: room.winner }); return; }
    }
    io.to(room.code).emit('state', publicState(room));
  }, 1000 / 30);
}
function roomCode() { const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s=''; for(let i=0;i<5;i++) s += chars[Math.floor(Math.random()*chars.length)]; return s; }

io.on('connection', socket => {
  socket.on('createRoom', (_, cb) => {
    let code; do { code = roomCode(); } while (rooms.has(code));
    const room = makeRoom(code, socket.id); const p = newPlayer(socket.id, 1); room.players.set(socket.id, p); socket.join(code);
    socket.data.room = code; socket.data.slot = 1;
    if (typeof cb === 'function') cb({ ok: true, code, slot: 1 });
    io.to(code).emit('state', publicState(room));
  });
  socket.on('joinRoom', (raw, cb) => {
    const code = String(raw || '').trim().toUpperCase(); const room = rooms.get(code);
    if (!room) return typeof cb === 'function' ? cb({ ok: false, error: '房间不存在，请检查房间号。' }) : null;
    if (room.players.size >= 2) return typeof cb === 'function' ? cb({ ok: false, error: '房间已满，最多两名玩家。' }) : null;
    if (room.status === 'finished') { room.status = 'waiting'; room.winner = null; }
    const p = newPlayer(socket.id, 2); room.players.set(socket.id, p); socket.join(code); socket.data.room = code; socket.data.slot = 2;
    room.status = 'playing'; room.lastTick = Date.now(); startLoop(room);
    if (typeof cb === 'function') cb({ ok: true, code, slot: 2 });
    io.to(code).emit('state', publicState(room)); io.to(code).emit('notice', '对手已加入，战斗开始！');
  });
  socket.on('input', data => {
    const room = rooms.get(socket.data.room); const p = room && room.players.get(socket.id); if (!p || room.status !== 'playing') return;
    const allowed = ['left','right','jump','punch','kick','special']; const next = {};
    for (const k of allowed) next[k] = !!(data && data[k]); p.input = next;
  });
  socket.on('rematch', () => {
    const room = rooms.get(socket.data.room); if (!room || room.players.size !== 2) return;
    room.winner = null; room.status = 'playing';
    for (const p of room.players.values()) { const fresh = newPlayer(p.id, p.slot); fresh.wins = p.wins; room.players.set(p.id, fresh); }
    room.lastTick = Date.now(); startLoop(room); io.to(room.code).emit('state', publicState(room)); io.to(room.code).emit('notice', '新一局开始！');
  });
  socket.on('disconnect', () => {
    const code = socket.data.room; const room = rooms.get(code); if (!room) return;
    room.players.delete(socket.id); if (room.tick) { clearInterval(room.tick); room.tick = null; }
    if (room.players.size === 0) rooms.delete(code);
    else { room.status = 'waiting'; room.winner = null; io.to(code).emit('state', publicState(room)); io.to(code).emit('notice', '对手已断开连接，等待重新加入。'); }
  });
});
server.listen(PORT, () => console.log(`Hotblood Online Fighter listening on ${PORT}`));
