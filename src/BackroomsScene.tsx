import { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { PointerLockControls } from '@react-three/drei';
import * as THREE from 'three';

// ---------- Seeded random ----------
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Theme = {
  wall: string; floor: string; ceiling: string; light: string; fog: string; ambience: string;
};
const themes: Record<string, Theme> = {
  yellow: { wall: '#d4b85a', floor: '#c4a35a', ceiling: '#c4b896', light: '#ffeeba', fog: '#1a1508', ambience: 'yellow' },
  red:    { wall: '#8b3a3a', floor: '#4a2a2a', ceiling: '#6b4a4a', light: '#ff6666', fog: '#200808', ambience: 'red' },
  pool:   { wall: '#8ba0a8', floor: '#a0c0c0', ceiling: '#c0d0d0', light: '#a0e0ff', fog: '#101820', ambience: 'pool' },
  dark:   { wall: '#1a1a1a', floor: '#111111', ceiling: '#222222', light: '#444444', fog: '#000000', ambience: 'dark' },
  concrete:{ wall: '#a0a0a0', floor: '#808080', ceiling: '#909090', light: '#ffffff', fog: '#202020', ambience: 'concrete' },
};

export interface Room {
  x: number; z: number; width: number; depth: number; height: number; type: 'room'; roomIndex?: number;
}
export interface Pitfall {
  x: number; z: number; size: number; roomIndex: number;
}

function generateLevel(seed: number, themeKey: string): {
  rooms: Room[]; pitfalls: Pitfall[]; grid: boolean[][]; exitPos: THREE.Vector3; startPos: THREE.Vector3; theme: Theme;
} {
  const rng = mulberry32(seed);
  const gridSize = 35;
  const roomMin = 2, roomMax = 5;
  const grid: boolean[][] = Array.from({ length: gridSize }, () => Array(gridSize).fill(false));
  const rooms: Room[] = [];

  const carveRect = (x: number, z: number, w: number, d: number) => {
    for (let ix = x; ix < x + w; ix++)
      for (let iz = z; iz < z + d; iz++)
        if (ix >= 0 && ix < gridSize && iz >= 0 && iz < gridSize) grid[ix][iz] = true;
  };

  const startW = 3, startD = 3;
  const startX = Math.floor(gridSize / 2) - Math.floor(startW / 2);
  const startZ = Math.floor(gridSize / 2) - Math.floor(startD / 2);
  carveRect(startX, startZ, startW, startD);
  rooms.push({ x: startX, z: startZ, width: startW, depth: startD, height: 3, type: 'room' });

  const attempts = 2000;
  let tries = 0;
  const targetRooms = 22;
  while (rooms.length < targetRooms && tries < attempts) {
    tries++;
    const parent = rooms[Math.floor(rng() * rooms.length)];
    const dirs: [number, number][] = [[1,0], [-1,0], [0,1], [0,-1]];
    for (let i = dirs.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
    }
    for (const [dx, dz] of dirs) {
      const newW = Math.floor(rng() * (roomMax - roomMin + 1)) + roomMin;
      const newD = Math.floor(rng() * (roomMax - roomMin + 1)) + roomMin;
      let nx: number, nz: number;
      if (dx === 1) {
        nx = parent.x + parent.width + 1;
        nz = parent.z + Math.floor(rng() * Math.max(1, parent.depth - newD));
      } else if (dx === -1) {
        nx = parent.x - newW - 1;
        nz = parent.z + Math.floor(rng() * Math.max(1, parent.depth - newD));
      } else if (dz === 1) {
        nx = parent.x + Math.floor(rng() * Math.max(1, parent.width - newW));
        nz = parent.z + parent.depth + 1;
      } else {
        nx = parent.x + Math.floor(rng() * Math.max(1, parent.width - newW));
        nz = parent.z - newD - 1;
      }
      if (nx < 0 || nz < 0 || nx + newW > gridSize || nz + newD > gridSize) continue;
      let overlap = false;
      for (let ix = nx; ix < nx + newW; ix++) {
        for (let iz = nz; iz < nz + newD; iz++) {
          if (grid[ix][iz]) { overlap = true; break; }
        }
        if (overlap) break;
      }
      if (overlap) continue;
      // Corridor
      if (dx === 1) { for (let ix = parent.x + parent.width; ix <= nx; ix++) carveRect(ix, nz + Math.floor(newD/2), 1, 1); }
      else if (dx === -1) { for (let ix = nx + newW; ix <= parent.x - 1; ix++) carveRect(ix, nz + Math.floor(newD/2), 1, 1); }
      else if (dz === 1) { for (let iz = parent.z + parent.depth; iz <= nz; iz++) carveRect(nx + Math.floor(newW/2), iz, 1, 1); }
      else { for (let iz = nz + newD; iz <= parent.z - 1; iz++) carveRect(nx + Math.floor(newW/2), iz, 1, 1); }
      carveRect(nx, nz, newW, newD);
      rooms.push({ x: nx, z: nz, width: newW, depth: newD, height: 3, type: 'room' });
      break;
    }
  }

  // Connectivity fix
  const visitedGrid = Array.from({ length: gridSize }, () => Array(gridSize).fill(false));
  const bfsQueue: [number, number][] = [[startX + Math.floor(startW/2), startZ + Math.floor(startD/2)]];
  visitedGrid[bfsQueue[0][0]][bfsQueue[0][1]] = true;
  while (bfsQueue.length) {
    const [cx, cz] = bfsQueue.shift()!;
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = cx + dx, nz = cz + dz;
      if (nx >= 0 && nx < gridSize && nz >= 0 && nz < gridSize && grid[nx][nz] && !visitedGrid[nx][nz]) {
        visitedGrid[nx][nz] = true;
        bfsQueue.push([nx, nz]);
      }
    }
  }
  for (const room of rooms) {
    if (room.roomIndex === 0) continue;
    let anyVisited = false;
    for (let ix = room.x; ix < room.x + room.width; ix++)
      for (let iz = room.z; iz < room.z + room.depth; iz++)
        if (visitedGrid[ix]?.[iz]) { anyVisited = true; break; }
    if (anyVisited) continue;
    let bestDist = Infinity, bestX = 0, bestZ = 0;
    for (let ix = 0; ix < gridSize; ix++)
      for (let iz = 0; iz < gridSize; iz++)
        if (visitedGrid[ix][iz]) {
          const dist = Math.abs(ix - (room.x + Math.floor(room.width/2))) + Math.abs(iz - (room.z + Math.floor(room.depth/2)));
          if (dist < bestDist) { bestDist = dist; bestX = ix; bestZ = iz; }
        }
    let cx = room.x + Math.floor(room.width/2), cz = room.z + Math.floor(room.depth/2);
    while (cx !== bestX || cz !== bestZ) {
      if (cx < bestX) cx++; else if (cx > bestX) cx--;
      else if (cz < bestZ) cz++; else if (cz > bestZ) cz--;
      carveRect(cx, cz, 1, 1);
    }
  }

  const pitfalls: Pitfall[] = [];
  rooms.forEach((room, idx) => {
    if (idx === 0) return;
    if (rng() < 0.25 && room.width >= 3 && room.depth >= 3) {
      const pitSize = Math.floor(rng() * 2) + 1;
      const mx = room.width - pitSize, mz = room.depth - pitSize;
      pitfalls.push({ x: room.x + Math.floor(rng() * mx), z: room.z + Math.floor(rng() * mz), size: pitSize, roomIndex: idx });
    }
  });

  let maxDist = 0, exitRoom = rooms[0];
  rooms.forEach(r => {
    const d = Math.abs(r.x - startX) + Math.abs(r.z - startZ);
    if (d > maxDist) { maxDist = d; exitRoom = r; }
  });
  const exitPos = new THREE.Vector3(exitRoom.x * 2 - 12, 0, exitRoom.z * 2 - 12);
  const startPos = new THREE.Vector3(startX * 2 - 12, 0.75, startZ * 2 - 12);
  const theme = themes[themeKey] || themes.yellow;
  return { rooms, pitfalls, grid, exitPos, startPos, theme };
}

// 3D Components
function VoidPlane() {
  return <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -200, 0]}><planeGeometry args={[1000, 1000]} /><meshBasicMaterial color="#000000" side={THREE.DoubleSide} /></mesh>;
}

function PitfallWarning({ pitfall }: { pitfall: Pitfall }) {
  const worldX = pitfall.x * 2 - 12 + (pitfall.size - 1);
  const worldZ = pitfall.z * 2 - 12 + (pitfall.size - 1);
  const size = pitfall.size * 2;
  return (
    <group position={[worldX, -1.48, worldZ]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <planeGeometry args={[size - 0.1, size - 0.1]} />
        <meshBasicMaterial color="#0a0a0a" side={THREE.DoubleSide} />
      </mesh>
      {/* Simple border using a thin box */}
      <mesh position={[0, 0.01, 0]}><boxGeometry args={[size, 0.02, size]} /><meshBasicMaterial color="#8b0000" transparent opacity={0.3} /></mesh>
    </group>
  );
}

function RoomBox({ room, isExit, pitfalls, theme }: { room: Room; isExit?: boolean; pitfalls: Pitfall[]; theme: Theme }) {
  const wallColor = isExit ? '#a8e6a1' : theme.wall;
  const floorColor = isExit ? '#6b8b6b' : theme.floor;
  const roomPits = pitfalls.filter(p => p.roomIndex === room.roomIndex);
  const [light, setLight] = useState(0.8);
  useEffect(() => {
    const iv = setInterval(() => setLight(0.6 + Math.random() * 0.4), 100 + Math.random() * 200);
    return () => clearInterval(iv);
  }, []);

  return (
    <group position={[room.x * 2 - 12, 0, room.z * 2 - 12]}>
      {/* Floor */}
      {roomPits.length === 0 ? (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.5, 0]}>
          <planeGeometry args={[room.width * 2, room.depth * 2]} />
          <meshStandardMaterial color={floorColor} side={THREE.DoubleSide} roughness={0.9} />
        </mesh>
      ) : (
        <>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.5, 0]}>
            <planeGeometry args={[room.width * 2, room.depth * 2]} />
            <meshStandardMaterial color={floorColor} side={THREE.DoubleSide} roughness={0.9} />
          </mesh>
          {roomPits.map((pit, i) => {
            const px = (pit.x - room.x) * 2 - room.width + pit.size;
            const pz = (pit.z - room.z) * 2 - room.depth + pit.size;
            const ps = pit.size * 2;
            return (
              <group key={`pit-${i}`} position={[px, -1.49, pz]}>
                <mesh rotation={[-Math.PI / 2, 0, 0]}>
                  <planeGeometry args={[ps - 0.05, ps - 0.05]} />
                  <meshBasicMaterial color="#000000" side={THREE.DoubleSide} />
                </mesh>
              </group>
            );
          })}
        </>
      )}
      {/* Ceiling */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 1.5, 0]}>
        <planeGeometry args={[room.width * 2, room.depth * 2]} />
        <meshStandardMaterial color={theme.ceiling} side={THREE.DoubleSide} roughness={0.8} />
      </mesh>
      {/* Walls */}
      <mesh position={[0, 0, room.depth]}><planeGeometry args={[room.width * 2, 3]} /><meshStandardMaterial color={wallColor} side={THREE.DoubleSide} roughness={0.85} /></mesh>
      <mesh position={[0, 0, -room.depth]}><planeGeometry args={[room.width * 2, 3]} /><meshStandardMaterial color={wallColor} side={THREE.DoubleSide} roughness={0.85} /></mesh>
      <mesh position={[room.width, 0, 0]} rotation={[0, Math.PI / 2, 0]}><planeGeometry args={[room.depth * 2, 3]} /><meshStandardMaterial color={wallColor} side={THREE.DoubleSide} roughness={0.85} /></mesh>
      <mesh position={[-room.width, 0, 0]} rotation={[0, -Math.PI / 2, 0]}><planeGeometry args={[room.depth * 2, 3]} /><meshStandardMaterial color={wallColor} side={THREE.DoubleSide} roughness={0.85} /></mesh>
      {isExit && <mesh position={[0, 1.4, 0]}><sphereGeometry args={[0.2, 16, 16]} /><meshStandardMaterial color="#33ff33" emissive="#33ff33" emissiveIntensity={2} /></mesh>}
      <pointLight position={[0, 1.4, 0]} intensity={light * (isExit ? 1.5 : 1)} distance={5} color={theme.light} />
      <mesh position={[0, 1.48, 0]}><boxGeometry args={[0.8, 0.05, 0.3]} /><meshStandardMaterial color="#f5f5dc" emissive="#fff8dc" emissiveIntensity={light * 0.5} /></mesh>
    </group>
  );
}

function Level({ rooms, pitfalls, exitPos, theme }: { rooms: Room[]; pitfalls: Pitfall[]; exitPos: THREE.Vector3; theme: Theme }) {
  return (
    <group>
      <VoidPlane />
      {rooms.map((room, idx) => {
        const isExit = Math.abs(room.x * 2 - 12 - exitPos.x) < 1 && Math.abs(room.z * 2 - 12 - exitPos.z) < 1;
        return <RoomBox key={idx} room={{ ...room, roomIndex: idx }} isExit={isExit} pitfalls={pitfalls} theme={theme} />;
      })}
      {pitfalls.map((pit, i) => <PitfallWarning key={`warn-${i}`} pitfall={pit} />)}
    </group>
  );
}

// Movement hook
function useSmoothMovement(
  keysRef: React.MutableRefObject<{ w: boolean; a: boolean; s: boolean; d: boolean }>,
  playerPosRef: React.MutableRefObject<THREE.Vector3>,
  exitPos: THREE.Vector3, setVictory: React.Dispatch<boolean>,
  gameStarted: boolean, victory: boolean,
  pitfalls: Pitfall[], startPos: THREE.Vector3,
  setFalling: React.Dispatch<boolean>, falling: boolean,
  grid: boolean[][]
) {
  const fallVel = useRef(0);

  useFrame((state, delta) => {
    if (!gameStarted || victory) return;
    if (falling) {
      fallVel.current += 9.8 * delta;
      state.camera.position.y -= fallVel.current * delta;
      if (state.camera.position.y < -50) {
        state.camera.position.copy(startPos);
        fallVel.current = 0;
        setFalling(false);
      }
      return;
    }

    const speed = 4 * delta;
    const moveDir = new THREE.Vector3();
    if (keysRef.current.w) moveDir.z -= 1;
    if (keysRef.current.s) moveDir.z += 1;
    if (keysRef.current.a) moveDir.x -= 1;
    if (keysRef.current.d) moveDir.x += 1;
    if (moveDir.length() === 0) return;

    moveDir.normalize();
    const camDir = new THREE.Vector3();
    state.camera.getWorldDirection(camDir);
    camDir.y = 0; camDir.normalize();
    const right = new THREE.Vector3().crossVectors(camDir, new THREE.Vector3(0, 1, 0)).normalize();

    const deltaX = right.clone().multiplyScalar(moveDir.x * speed);
    const deltaZ = camDir.clone().multiplyScalar(-moveDir.z * speed);
    const oldPos = state.camera.position.clone();

    const canMoveTo = (x: number, z: number) => {
      const gx = Math.round((x + 12) / 2);
      const gz = Math.round((z + 12) / 2);
      return gx >= 0 && gx < grid.length && gz >= 0 && gz < grid[0].length && grid[gx][gz];
    };

    if (moveDir.x !== 0) {
      const testX = oldPos.clone().add(deltaX);
      if (canMoveTo(testX.x, testX.z)) state.camera.position.x = testX.x;
    }
    if (moveDir.z !== 0) {
      const testZ = oldPos.clone().add(deltaZ);
      if (canMoveTo(testZ.x, testZ.z)) state.camera.position.z = testZ.z;
    }

    const px = state.camera.position.x, pz = state.camera.position.z;
    for (const pit of pitfalls) {
      const pitX = pit.x * 2 - 12 + (pit.size - 1);
      const pitZ = pit.z * 2 - 12 + (pit.size - 1);
      const half = pit.size;
      if (px >= pitX - half && px <= pitX + half && pz >= pitZ - half && pz <= pitZ + half) {
        setFalling(true);
        fallVel.current = 0;
        return;
      }
    }

    state.camera.position.y = 0.75;
    playerPosRef.current.copy(state.camera.position);
    if (state.camera.position.distanceTo(exitPos) < 2.5) setVictory(true);
  });
}

// Player component that uses the hook
function PlayerMovementComponent(props: any) {
  useSmoothMovement(
    props.keysRef, props.playerPosRef, props.exitPos, props.setVictory,
    props.gameStarted, props.victory, props.pitfalls, props.startPos,
    props.setFalling, props.falling, props.grid
  );
  return null;
}

// Creature
function Creature({ playerPosRef, startPos, gameStarted, victory, setGameStarted, falling, creatureActive }: any) {
  const meshRef = useRef<THREE.Mesh>(null!);
  const pos = useRef(new THREE.Vector3(0, 1, 0));
  const speed = 0.005;
  const [vis, setVis] = useState(false);
  const timer = useRef(0);

  const handleCatch = useCallback(() => {
    // Reset player
    if (playerPosRef.current) playerPosRef.current.copy(startPos);
    pos.current.set(startPos.x + 10, 1, startPos.z + 10);
    setGameStarted(false);
  }, [startPos, setGameStarted, playerPosRef]);

  useFrame((_state, delta) => {
    if (!gameStarted || victory || falling || !creatureActive) return;
    timer.current += delta;
    if (timer.current > 2 + Math.random() * 3) { setVis(Math.random() > 0.3); timer.current = 0; }
    const dir = new THREE.Vector3().copy(playerPosRef.current).sub(pos.current).normalize();
    pos.current.add(dir.multiplyScalar(speed));
    meshRef.current.position.copy(pos.current);
    meshRef.current.lookAt(playerPosRef.current);
    if (pos.current.distanceTo(playerPosRef.current) < 1.2) handleCatch();
  });

  return <mesh ref={meshRef} position={pos.current} visible={vis}><coneGeometry args={[0.5, 1.5, 8]} /><meshStandardMaterial color="#1a0000" emissive="#330000" emissiveIntensity={0.5} /></mesh>;
}

// Mobile controls
function MobileControls({ onMove, onLook }: any) {
  const joyRef = useRef<HTMLDivElement>(null);
  const lookRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const s = joyRef.current; if (!s) return;
    let down = false; let sp = { x: 0, y: 0 };
    const st = (e: TouchEvent) => { e.preventDefault(); down = true; sp = { x: e.touches[0].clientX, y: e.touches[0].clientY }; };
    const mv = (e: TouchEvent) => {
      if (!down) return; e.preventDefault();
      const t = e.touches[0]; const dx = t.clientX - sp.x, dy = t.clientY - sp.y;
      const max = 40; onMove(Math.max(-1, Math.min(1, dx / max)), Math.max(-1, Math.min(1, dy / max)));
    };
    const en = () => { down = false; onMove(0, 0); };
    s.addEventListener('touchstart', st, { passive: false }); s.addEventListener('touchmove', mv, { passive: false }); s.addEventListener('touchend', en);
    return () => { s.removeEventListener('touchstart', st); s.removeEventListener('touchmove', mv); s.removeEventListener('touchend', en); };
  }, [onMove]);
  useEffect(() => {
    const a = lookRef.current; if (!a) return;
    let lt = { x: 0, y: 0 };
    const st = (e: TouchEvent) => { e.preventDefault(); lt = { x: e.touches[0].clientX, y: e.touches[0].clientY }; };
    const mv = (e: TouchEvent) => {
      e.preventDefault(); const t = e.touches[0]; const dx = t.clientX - lt.x, dy = t.clientY - lt.y;
      lt = { x: t.clientX, y: t.clientY }; onLook(dx * 0.01, dy * 0.01);
    };
    a.addEventListener('touchstart', st, { passive: false }); a.addEventListener('touchmove', mv, { passive: false });
    return () => { a.removeEventListener('touchstart', st); a.removeEventListener('touchmove', mv); };
  }, [onLook]);
  return (
    <>
      <div ref={joyRef} style={{ position: 'absolute', bottom: '20px', left: '20px', width: '80px', height: '80px', background: 'rgba(255,255,255,0.2)', borderRadius: '50%', border: '2px solid rgba(255,255,255,0.5)', touchAction: 'none' }} />
      <div ref={lookRef} style={{ position: 'absolute', top: 0, right: 0, width: '60%', height: '100%', touchAction: 'none' }} />
    </>
  );
}

// Audio
function useAudio(gameStarted: boolean, victory: boolean, falling: boolean) {
  useEffect(() => {
    if (gameStarted && !victory && !falling) {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = 60;
      gain.gain.value = 0.05;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      const stepInterval = setInterval(() => {
        if (!gameStarted || victory || falling) return;
        const buffer = ctx.createBuffer(1, ctx.sampleRate * 0.05, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 0.1;
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.start();
      }, 500);
      return () => {
        clearInterval(stepInterval);
        osc.stop();
        ctx.close();
      };
    }
  }, [gameStarted, victory, falling]);
}

export default function BackroomsScene() {
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 100000));
  const [themeKey, setThemeKey] = useState('yellow');
  const level = useMemo(() => generateLevel(seed, themeKey), [seed, themeKey]);
  const { rooms, pitfalls, grid, exitPos, startPos, theme } = level;
  const [started, setStarted] = useState(false);
  const [victory, setVictory] = useState(false);
  const [falling, setFalling] = useState(false);
  const [creatureOn, setCreatureOn] = useState(false);
  const playerRef = useRef(new THREE.Vector3().copy(startPos));
  const keysRef = useRef({ w: false, a: false, s: false, d: false });
  const camRef = useRef<any>(null);

  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if (e.key === 'w' || e.key === 'W') keysRef.current.w = true;
      if (e.key === 'a' || e.key === 'A') keysRef.current.a = true;
      if (e.key === 's' || e.key === 'S') keysRef.current.s = true;
      if (e.key === 'd' || e.key === 'D') keysRef.current.d = true;
    };
    const ku = (e: KeyboardEvent) => {
      if (e.key === 'w' || e.key === 'W') keysRef.current.w = false;
      if (e.key === 'a' || e.key === 'A') keysRef.current.a = false;
      if (e.key === 's' || e.key === 'S') keysRef.current.s = false;
      if (e.key === 'd' || e.key === 'D') keysRef.current.d = false;
    };
    window.addEventListener('keydown', kd); window.addEventListener('keyup', ku);
    return () => { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); };
  }, []);

  useEffect(() => {
    if (started && !victory && !falling) {
      const t = setTimeout(() => setCreatureOn(true), 120000);
      return () => clearTimeout(t);
    } else setCreatureOn(false);
  }, [started, victory, falling]);

  useAudio(started, victory, falling);

  const handleMove = useCallback((x: number, z: number) => {
    keysRef.current.a = x < -0.2;
    keysRef.current.d = x > 0.2;
    keysRef.current.w = z < -0.2;
    keysRef.current.s = z > 0.2;
  }, []);
  const handleLook = useCallback((dx: number, dy: number) => {
    if (camRef.current) { camRef.current.moveRight(dx); camRef.current.moveForward(dy); }
  }, []);

  const resetView = () => {
    if (camRef.current?.camera) {
      camRef.current.camera.position.copy(startPos);
      playerRef.current.copy(startPos);
    }
    setFalling(false);
  };

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', touchAction: 'none', background: '#000' }}>
      <Canvas camera={{ position: startPos.toArray(), fov: 75 }} onCreated={({ camera }) => playerRef.current.copy(camera.position)}>
        <fog attach="fog" args={[theme.fog, 5, 30]} />
        <ambientLight intensity={0.15} />
        <Level rooms={rooms} pitfalls={pitfalls} exitPos={exitPos} theme={theme} />
        {started && !victory && (
          <>
            <PointerLockControls ref={camRef} />
            <Creature playerPosRef={playerRef} startPos={startPos} gameStarted={started} victory={victory} setGameStarted={setStarted} falling={falling} creatureActive={creatureOn} />
          </>
        )}
        <PlayerMovementComponent
          keysRef={keysRef} playerPosRef={playerRef} exitPos={exitPos} setVictory={setVictory}
          gameStarted={started} victory={victory} pitfalls={pitfalls} startPos={startPos}
          setFalling={setFalling} falling={falling} grid={grid}
        />
      </Canvas>

      {!started && (
        <div onClick={() => setStarted(true)} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.85)', color: '#d4b85a', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 10, fontSize: '2rem', fontFamily: 'monospace' }}>
          <div style={{ fontSize: '3rem', marginBottom: '20px' }}>🏢</div>
          <div>Click to enter the Backrooms</div>
          <div style={{ fontSize: '1rem', color: '#8b7355', marginTop: '15px' }}>Watch your step. Not all floors are solid.</div>
          <div style={{ marginTop: '20px', display: 'flex', gap: '10px' }}>
            {Object.keys(themes).map(t => (
              <button key={t} onClick={(e) => { e.stopPropagation(); setThemeKey(t); setSeed(Math.floor(Math.random() * 100000)); }} style={{ background: themes[t].wall, border: 'none', padding: '8px 14px', borderRadius: '4px', cursor: 'pointer', fontFamily: 'monospace', color: '#fff' }}>{t}</button>
            ))}
          </div>
        </div>
      )}

      {falling && (
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.95)', color: '#8b0000', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 10, fontSize: '2rem', fontFamily: 'monospace' }}>
          <div style={{ fontSize: '3rem', marginBottom: '20px' }}>🕳️</div>
          <div>You fell into the void...</div>
        </div>
      )}

      {victory && (
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.8)', color: '#33ff33', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 10, fontSize: '3rem', fontFamily: 'monospace' }}>
          🎉 You Escaped! 🎉
          <button onClick={() => { setSeed(Math.floor(Math.random() * 100000)); setStarted(false); setVictory(false); setFalling(false); }} style={{ marginTop: '20px', fontSize: '1.5rem', padding: '10px 20px' }}>New Level</button>
        </div>
      )}

      <div style={{ position: 'absolute', bottom: '20px', left: '20px', color: '#8b7355', fontSize: '14px', background: 'rgba(0,0,0,0.6)', padding: '6px 14px', borderRadius: '8px', pointerEvents: 'none', border: '1px solid #3a3020' }}>
        <div>WASD move, mouse look | Seed: {seed} | Theme: {themeKey}</div>
        <div style={{ fontSize: '11px', color: '#5a4a3a', marginTop: '4px' }}>⚠️ Beware of dark square holes in the floor</div>
        {!creatureOn && started && !victory && <div style={{ color: '#5a4a3a', marginTop: '4px' }}>Creature arrives in 2 min...</div>}
        <div style={{ pointerEvents: 'auto', marginTop: '8px' }}>
          {started && !victory && !falling && <button onClick={resetView} style={{ marginRight: '8px', background: '#3a3020', color: '#d4b85a', border: '1px solid #5a4a3a', padding: '4px 12px', borderRadius: '4px', cursor: 'pointer', fontFamily: 'monospace' }}>Reset</button>}
          <button onClick={() => { setSeed(Math.floor(Math.random() * 100000)); setStarted(false); setVictory(false); setFalling(false); }} style={{ background: '#3a3020', color: '#d4b85a', border: '1px solid #5a4a3a', padding: '4px 12px', borderRadius: '4px', cursor: 'pointer', fontFamily: 'monospace' }}>New Level</button>
        </div>
      </div>

      {started && !victory && !falling && <MobileControls onMove={handleMove} onLook={handleLook} />}
    </div>
  );
}
