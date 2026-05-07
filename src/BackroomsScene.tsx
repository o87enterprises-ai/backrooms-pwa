import { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PointerLockControls } from '@react-three/drei';
import * as THREE from 'three';

// ---------- Seeded random ----------
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Room {
  x: number;          // top-left grid column
  z: number;          // top-left grid row
  width: number;
  depth: number;
  height: number;
  type: 'room' | 'corridor';
  roomIndex?: number;
}

export interface Pitfall {
  x: number;
  z: number;
  size: number;
  roomIndex: number;
}

function generateLevel(seed: number): {
  rooms: Room[];
  pitfalls: Pitfall[];
  grid: boolean[][];
  exitPos: THREE.Vector3;
  startPos: THREE.Vector3;
} {
  const rng = mulberry32(seed);
  const gridSize = 25;
  const roomMin = 2;
  const roomMax = 5;
  const grid: boolean[][] = Array.from({ length: gridSize }, () =>
    Array(gridSize).fill(false)
  );
  const rooms: Room[] = [];

  const carve = (x: number, z: number) => {
    if (x >= 0 && z >= 0 && x < gridSize && z < gridSize) grid[x][z] = true;
  };

  const carveRect = (x: number, z: number, w: number, d: number) => {
    for (let ix = x; ix < x + w; ix++) {
      for (let iz = z; iz < z + d; iz++) {
        carve(ix, iz);
      }
    }
  };

  // Place start room
  const startW = 3, startD = 3;
  const startX = Math.floor(gridSize / 2) - Math.floor(startW / 2);
  const startZ = Math.floor(gridSize / 2) - Math.floor(startD / 2);
  carveRect(startX, startZ, startW, startD);
  rooms.push({ x: startX, z: startZ, width: startW, depth: startD, height: 3, type: 'room' });

  // Generate a list of rooms and connect them with corridors
  const numExtraRooms = 15; // total rooms besides start
  const roomPlacements: { x: number; z: number; w: number; d: number }[] = [];

  for (let i = 0; i < numExtraRooms; i++) {
    const w = Math.floor(rng() * (roomMax - roomMin + 1)) + roomMin;
    const d = Math.floor(rng() * (roomMax - roomMin + 1)) + roomMin;
    // Try to place the room adjacent to an existing carved cell
    const edges = getEdges(grid, gridSize);
    if (edges.length === 0) break;
    // Pick a random edge cell
    const edge = edges[Math.floor(rng() * edges.length)];
    // Determine direction from edge to place new room
    const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    rngShuffle(dirs, rng);
    let placed = false;
    for (const [dx, dz] of dirs) {
      // Candidate top-left of new room is adjacent to the edge cell in direction (dx,dz)
      let nx = edge.x + dx;
      let nz = edge.z + dz;
      // Adjust so that the edge cell is adjacent to the new room
      if (dx === 1) nx = edge.x + 1;
      if (dx === -1) nx = edge.x - w;
      if (dz === 1) nz = edge.z + 1;
      if (dz === -1) nz = edge.z - d;
      // Bounds check and overlap check
      if (nx >= 0 && nz >= 0 && nx + w <= gridSize && nz + d <= gridSize) {
        let overlap = false;
        for (let ix = nx; ix < nx + w; ix++) {
          for (let iz = nz; iz < nz + d; iz++) {
            if (grid[ix][iz]) { overlap = true; break; }
          }
          if (overlap) break;
        }
        if (!overlap) {
          // Carve corridor from edge cell to the new room
          // The edge cell is at (edge.x, edge.z). The new room is adjacent, so we need to carve a passage of width 1 between them.
          // The corridor cells are the edge cell and the adjacent cell in the new room.
          // Since we placed the new room adjacent, the corridor is already partly carved by edge cell being in the existing area.
          // We'll carve a 1-cell wide passage from edge cell to the new room's interior.
          // For simplicity, carve the cell(s) connecting edge to new room.
          let corrCells: [number, number][] = [];
          if (dx === 1) {
            for (let i = 0; i < w; i++) {
              corrCells.push([edge.x + 1 + i, edge.z]);
            }
          } else if (dx === -1) {
            for (let i = 0; i < w; i++) {
              corrCells.push([edge.x - 1 - i, edge.z]);
            }
          } else if (dz === 1) {
            for (let i = 0; i < d; i++) {
              corrCells.push([edge.x, edge.z + 1 + i]);
            }
          } else if (dz === -1) {
            for (let i = 0; i < d; i++) {
              corrCells.push([edge.x, edge.z - 1 - i]);
            }
          }
          corrCells.forEach(([cx, cz]) => carve(cx, cz));
          // Carve the room itself
          carveRect(nx, nz, w, d);
          rooms.push({ x: nx, z: nz, width: w, depth: d, height: 3, type: 'room' });
          placed = true;
          break;
        }
      }
    }
    if (!placed) {
      // Could not place room, skip (rare)
    }
  }

  // Generate pitfalls (square floor holes) in rooms (not start room)
  const pitfalls: Pitfall[] = [];
  rooms.forEach((room, idx) => {
    if (idx === 0) return; // Don't put pitfalls in start room
    if (rng() < 0.3 && room.width >= 3 && room.depth >= 3) {
      const pitSize = Math.floor(rng() * 2) + 1; // 1 or 2 units
      const maxOffsetX = room.width - pitSize;
      const maxOffsetZ = room.depth - pitSize;
      const offsetX = Math.floor(rng() * maxOffsetX);
      const offsetZ = Math.floor(rng() * maxOffsetZ);
      pitfalls.push({
        x: room.x + offsetX,
        z: room.z + offsetZ,
        size: pitSize,
        roomIndex: idx,
      });
    }
  });

  // Determine exit room: farthest from start (Manhattan distance in grid coordinates)
  let maxDist = 0;
  let exitRoom: Room = rooms[0];
  rooms.forEach((room) => {
    const dist = Math.abs(room.x - startX) + Math.abs(room.z - startZ);
    if (dist > maxDist) {
      maxDist = dist;
      exitRoom = room;
    }
  });
  const exitPos = new THREE.Vector3(
    exitRoom.x * 2 - 12,
    0,
    exitRoom.z * 2 - 12
  );
  const startPos = new THREE.Vector3(
    startX * 2 - 12,
    1.5,
    startZ * 2 - 12
  );
  return { rooms, pitfalls, grid, exitPos, startPos };
}

// Utility: get all carved cells that have at least one empty neighbor
function getEdges(grid: boolean[][], size: number): { x: number; z: number }[] {
  const edges: { x: number; z: number }[] = [];
  for (let x = 0; x < size; x++) {
    for (let z = 0; z < size; z++) {
      if (!grid[x][z]) continue;
      if (
        (x > 0 && !grid[x - 1][z]) ||
        (x < size - 1 && !grid[x + 1][z]) ||
        (z > 0 && !grid[x][z - 1]) ||
        (z < size - 1 && !grid[x][z + 1])
      ) {
        edges.push({ x, z });
      }
    }
  }
  return edges;
}

// Fisher‑Yates shuffle for arrays
function rngShuffle<T>(arr: T[], rng: () => number) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ---------- 3D Components ----------

function VoidPlane() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -200, 0]}>
      <planeGeometry args={[1000, 1000]} />
      <meshBasicMaterial color="#000000" side={THREE.DoubleSide} />
    </mesh>
  );
}

function PitfallWarning({ pitfall }: { pitfall: Pitfall }) {
  const worldX = pitfall.x * 2 - 12 + (pitfall.size - 1);
  const worldZ = pitfall.z * 2 - 12 + (pitfall.size - 1);
  const size = pitfall.size * 2;

  const points = [
    new THREE.Vector3(-size/2, 0, -size/2),
    new THREE.Vector3(size/2, 0, -size/2),
    new THREE.Vector3(size/2, 0, size/2),
    new THREE.Vector3(-size/2, 0, size/2),
    new THREE.Vector3(-size/2, 0, -size/2),
  ];
  const lineGeometry = new THREE.BufferGeometry().setFromPoints(points);

  return (
    <group position={[worldX, -1.48, worldZ]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <planeGeometry args={[size - 0.1, size - 0.1]} />
        <meshBasicMaterial color="#0a0a0a" side={THREE.DoubleSide} />
      </mesh>
      <line geometry={lineGeometry}>
        <lineBasicMaterial color="#8b0000" transparent opacity={0.3} />
      </line>
    </group>
  );
}

function generateFloorSegments(room: Room, roomPitfalls: Pitfall[], floorColor: string) {
  const segments: JSX.Element[] = [];
  const fullW = room.width * 2;
  const fullD = room.depth * 2;

  segments.push(
    <mesh key="floor-base" rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.5, 0]}>
      <planeGeometry args={[fullW, fullD]} />
      <meshStandardMaterial color={floorColor} side={THREE.DoubleSide} roughness={0.9} />
    </mesh>
  );

  roomPitfalls.forEach((pit, idx) => {
    const pitWorldX = (pit.x - room.x) * 2 - room.width + pit.size;
    const pitWorldZ = (pit.z - room.z) * 2 - room.depth + pit.size;
    const pitSize = pit.size * 2;

    segments.push(
      <group key={`pit-${idx}`} position={[pitWorldX, -1.49, pitWorldZ]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[pitSize - 0.05, pitSize - 0.05]} />
          <meshBasicMaterial color="#000000" side={THREE.DoubleSide} />
        </mesh>
        <lineSegments>
          <edgesGeometry args={[new THREE.PlaneGeometry(pitSize, pitSize)]} />
          <lineBasicMaterial color="#660000" transparent opacity={0.5} />
        </lineSegments>
      </group>
    );
  });

  return segments;
}

function DampStains({ room, rng }: { room: Room; rng: () => number }) {
  const stains = useMemo(() => {
    const count = Math.floor(rng() * 3) + 1;
    const result = [];
    for (let i = 0; i < count; i++) {
      result.push({
        x: (rng() - 0.5) * room.width * 1.8,
        y: (rng() - 0.5) * 2,
        z: room.depth * (rng() > 0.5 ? 0.99 : -0.99),
        scale: 0.1 + rng() * 0.3,
        rotation: rng() * Math.PI,
      });
    }
    return result;
  }, [room, rng]);

  return (
    <>
      {stains.map((stain, i) => (
        <mesh
          key={i}
          position={[stain.x, stain.y, stain.z]}
          rotation={[0, stain.rotation, 0]}
        >
          <circleGeometry args={[stain.scale, 8]} />
          <meshBasicMaterial color="#5a4a3a" transparent opacity={0.4} />
        </mesh>
      ))}
    </>
  );
}

function RoomBox({ room, isExit, pitfalls }: { room: Room; isExit?: boolean; pitfalls: Pitfall[] }) {
  const wallColor = isExit ? '#a8e6a1' : '#d4b85a';
  const floorColor = isExit ? '#6b8b6b' : '#c4a35a';
  const emissive = isExit ? new THREE.Color('#33ff33') : new THREE.Color('#000000');

  const roomPitfalls = pitfalls.filter(p => p.roomIndex === room.roomIndex);

  const [lightIntensity, setLightIntensity] = useState(0.8);
  useEffect(() => {
    const interval = setInterval(() => {
      setLightIntensity(0.6 + Math.random() * 0.4);
    }, 100 + Math.random() * 200);
    return () => clearInterval(interval);
  }, []);

  return (
    <group position={[room.x * 2 - 12, 0, room.z * 2 - 12]}>
      {roomPitfalls.length === 0 ? (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.5, 0]}>
          <planeGeometry args={[room.width * 2, room.depth * 2]} />
          <meshStandardMaterial color={floorColor} side={THREE.DoubleSide} roughness={0.9} />
        </mesh>
      ) : (
        <>{generateFloorSegments(room, roomPitfalls, floorColor)}</>
      )}

      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 1.5, 0]}>
        <planeGeometry args={[room.width * 2, room.depth * 2]} />
        <meshStandardMaterial color="#c4b896" side={THREE.DoubleSide} roughness={0.8} />
      </mesh>

      <mesh position={[0, 0, room.depth]}>
        <planeGeometry args={[room.width * 2, 3]} />
        <meshStandardMaterial color={wallColor} side={THREE.DoubleSide} roughness={0.85} />
      </mesh>
      <mesh position={[0, 0, -room.depth]}>
        <planeGeometry args={[room.width * 2, 3]} />
        <meshStandardMaterial color={wallColor} side={THREE.DoubleSide} roughness={0.85} />
      </mesh>
      <mesh position={[room.width, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[room.depth * 2, 3]} />
        <meshStandardMaterial color={wallColor} side={THREE.DoubleSide} roughness={0.85} />
      </mesh>
      <mesh position={[-room.width, 0, 0]} rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[room.depth * 2, 3]} />
        <meshStandardMaterial color={wallColor} side={THREE.DoubleSide} roughness={0.85} />
      </mesh>

      <DampStains room={room} rng={Math.random} />

      {isExit && (
        <mesh position={[0, 1.4, 0]}>
          <sphereGeometry args={[0.2, 16, 16]} />
          <meshStandardMaterial color="#33ff33" emissive={emissive} emissiveIntensity={2} />
        </mesh>
      )}

      <pointLight
        position={[0, 1.4, 0]}
        intensity={lightIntensity * (isExit ? 1.5 : 1)}
        distance={5}
        color={isExit ? '#ccffcc' : '#ffeeba'}
      />

      <mesh position={[0, 1.48, 0]}>
        <boxGeometry args={[0.8, 0.05, 0.3]} />
        <meshStandardMaterial color="#f5f5dc" emissive="#fff8dc" emissiveIntensity={lightIntensity * 0.5} />
      </mesh>
    </group>
  );
}

function Level({
  rooms,
  pitfalls,
  exitPos,
}: {
  rooms: Room[];
  pitfalls: Pitfall[];
  exitPos: THREE.Vector3;
}) {
  return (
    <group>
      <VoidPlane />
      {rooms.map((room, idx) => {
        const isExit =
          Math.abs(room.x * 2 - 12 - exitPos.x) < 1 &&
          Math.abs(room.z * 2 - 12 - exitPos.z) < 1;
        return (
          <RoomBox
            key={idx}
            room={{ ...room, roomIndex: idx }}
            isExit={isExit}
            pitfalls={pitfalls}
          />
        );
      })}
      {pitfalls.map((pit, idx) => (
        <PitfallWarning key={`warning-${idx}`} pitfall={pit} />
      ))}
    </group>
  );
}

// ---------- Grid-based wall clamp ----------
function useGridClamp(grid: boolean[][], active: boolean) {
  const { camera } = useThree();

  useFrame(() => {
    if (!active) return;
    const pos = camera.position;
    const gridX = Math.round((pos.x + 12) / 2);
    const gridZ = Math.round((pos.z + 12) / 2);

    if (gridX < 0 || gridX >= grid.length || gridZ < 0 || gridZ >= grid[0].length || !grid[gridX]?.[gridZ]) {
      // Find nearest valid cell
      let bestDist = Infinity;
      let bestX = pos.x, bestZ = pos.z;
      for (let ix = 0; ix < grid.length; ix++) {
        for (let iz = 0; iz < grid[0].length; iz++) {
          if (grid[ix][iz]) {
            const worldX = ix * 2 - 12;
            const worldZ = iz * 2 - 12;
            const dist = (pos.x - worldX) ** 2 + (pos.z - worldZ) ** 2;
            if (dist < bestDist) {
              bestDist = dist;
              bestX = worldX;
              bestZ = worldZ;
            }
          }
        }
      }
      camera.position.x = bestX;
      camera.position.z = bestZ;
    }
  });
}

// ---------- Player movement ----------
function PlayerMovement({
  keysRef,
  playerPosRef,
  exitPos,
  setVictory,
  gameStarted,
  victory,
  pitfalls,
  startPos,
  setFalling,
  falling,
  grid,
}: {
  keysRef: React.MutableRefObject<{ w: boolean; a: boolean; s: boolean; d: boolean }>;
  playerPosRef: React.MutableRefObject<THREE.Vector3>;
  exitPos: THREE.Vector3;
  setVictory: React.Dispatch<React.SetStateAction<boolean>>;
  gameStarted: boolean;
  victory: boolean;
  pitfalls: Pitfall[];
  rooms: Room[];
  startPos: THREE.Vector3;
  setFalling: React.Dispatch<React.SetStateAction<boolean>>;
  falling: boolean;
  grid: boolean[][];
}) {
  const { camera } = useThree();
  const fallVelocity = useRef(0);

  // Movement
  useFrame((state, delta) => {
    if (!gameStarted || victory) return;

    if (falling) {
      fallVelocity.current += 9.8 * delta;
      state.camera.position.y -= fallVelocity.current * delta;
      if (state.camera.position.y < -50) {
        state.camera.position.copy(startPos);
        fallVelocity.current = 0;
        setFalling(false);
      }
      return;
    }

    const moveSpeed = 4 * delta;
    const dir = new THREE.Vector3();
    if (keysRef.current.w) dir.z -= 1;
    if (keysRef.current.s) dir.z += 1;
    if (keysRef.current.a) dir.x -= 1;
    if (keysRef.current.d) dir.x += 1;

    if (dir.length() > 0) {
      dir.normalize();
      const cameraDir = new THREE.Vector3();
      state.camera.getWorldDirection(cameraDir);
      cameraDir.y = 0;
      cameraDir.normalize();
      const right = new THREE.Vector3()
        .crossVectors(cameraDir, new THREE.Vector3(0, 1, 0))
        .normalize();
      const moveX = right.clone().multiplyScalar(dir.x * moveSpeed);
      const moveZ = cameraDir.clone().multiplyScalar(-dir.z * moveSpeed);
      state.camera.position.add(moveX);
      state.camera.position.add(moveZ);
    }

    // Pitfall check
    const playerX = state.camera.position.x;
    const playerZ = state.camera.position.z;
    let overPitfall = false;
    for (const pit of pitfalls) {
      const pitWorldX = pit.x * 2 - 12 + (pit.size - 1);
      const pitWorldZ = pit.z * 2 - 12 + (pit.size - 1);
      const halfSize = pit.size;
      if (
        playerX >= pitWorldX - halfSize &&
        playerX <= pitWorldX + halfSize &&
        playerZ >= pitWorldZ - halfSize &&
        playerZ <= pitWorldZ + halfSize
      ) {
        overPitfall = true;
        break;
      }
    }

    if (overPitfall) {
      setFalling(true);
      fallVelocity.current = 0;
      return;
    }

    state.camera.position.y = 0.75;
    playerPosRef.current.copy(state.camera.position);

    if (state.camera.position.distanceTo(exitPos) < 2.5) {
      setVictory(true);
    }
  });

  // Wall clamp (runs after movement)
  useGridClamp(grid, gameStarted && !victory && !falling);

  return null;
}

// ---------- Creature ----------
function Creature({
  playerPosRef,
  startPos,
  gameStarted,
  victory,
  setGameStarted,
  falling,
  creatureActive,
}: {
  playerPosRef: React.MutableRefObject<THREE.Vector3>;
  startPos: THREE.Vector3;
  gameStarted: boolean;
  victory: boolean;
  setGameStarted: React.Dispatch<React.SetStateAction<boolean>>;
  falling: boolean;
  creatureActive: boolean;
}) {
  const meshRef = useRef<THREE.Mesh>(null!);
  const position = useRef(new THREE.Vector3(0, 1, 0));
  const speed = 0.025;
  const { camera } = useThree();
  const [visible, setVisible] = useState(false);
  const visibilityTimer = useRef(0);

  const handleCatch = useCallback(() => {
    camera.position.copy(startPos);
    position.current.set(startPos.x + 10, 1, startPos.z + 10);
    setGameStarted(false);
  }, [camera, startPos, setGameStarted]);

  useFrame((state, delta) => {
    if (!gameStarted || victory || falling || !creatureActive) return;
    if (!meshRef.current || !playerPosRef.current) return;

    visibilityTimer.current += delta;
    if (visibilityTimer.current > 2 + Math.random() * 3) {
      setVisible(Math.random() > 0.3);
      visibilityTimer.current = 0;
    }

    const dir = new THREE.Vector3()
      .copy(playerPosRef.current)
      .sub(position.current)
      .normalize();
    position.current.add(dir.multiplyScalar(speed));
    meshRef.current.position.copy(position.current);

    meshRef.current.lookAt(playerPosRef.current);

    if (position.current.distanceTo(playerPosRef.current) < 1.2) {
      handleCatch();
    }
  });

  return (
    <mesh ref={meshRef} position={position.current} visible={visible}>
      <coneGeometry args={[0.5, 1.5, 8]} />
      <meshStandardMaterial color="#1a0000" emissive="#330000" emissiveIntensity={0.5} />
    </mesh>
  );
}

// ---------- Mobile controls ----------
function MobileControls({
  onMove,
  onLook,
}: {
  onMove: (x: number, z: number) => void;
  onLook: (dx: number, dy: number) => void;
}) {
  const joystickRef = useRef<HTMLDivElement>(null);
  const lookAreaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stick = joystickRef.current;
    if (!stick) return;
    let dragging = false;
    let startPos = { x: 0, y: 0 };

    const handleStart = (e: TouchEvent) => {
      e.preventDefault();
      dragging = true;
      const touch = e.touches[0];
      startPos = { x: touch.clientX, y: touch.clientY };
    };
    const handleMove = (e: TouchEvent) => {
      if (!dragging) return;
      e.preventDefault();
      const touch = e.touches[0];
      const dx = touch.clientX - startPos.x;
      const dy = touch.clientY - startPos.y;
      const maxDist = 40;
      const nx = Math.max(-1, Math.min(1, dx / maxDist));
      const nz = Math.max(-1, Math.min(1, dy / maxDist));
      onMove(nx, nz);
    };
    const handleEnd = () => {
      dragging = false;
      onMove(0, 0);
    };

    stick.addEventListener('touchstart', handleStart, { passive: false });
    stick.addEventListener('touchmove', handleMove, { passive: false });
    stick.addEventListener('touchend', handleEnd);
    return () => {
      stick.removeEventListener('touchstart', handleStart);
      stick.removeEventListener('touchmove', handleMove);
      stick.removeEventListener('touchend', handleEnd);
    };
  }, [onMove]);

  useEffect(() => {
    const area = lookAreaRef.current;
    if (!area) return;
    let lastTouch = { x: 0, y: 0 };

    const handleTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      const touch = e.touches[0];
      lastTouch = { x: touch.clientX, y: touch.clientY };
    };
    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      const touch = e.touches[0];
      const dx = touch.clientX - lastTouch.x;
      const dy = touch.clientY - lastTouch.y;
      lastTouch = { x: touch.clientX, y: touch.clientY };
      onLook(dx * 0.01, dy * 0.01);
    };

    area.addEventListener('touchstart', handleTouchStart, { passive: false });
    area.addEventListener('touchmove', handleTouchMove, { passive: false });
    return () => {
      area.removeEventListener('touchstart', handleTouchStart);
      area.removeEventListener('touchmove', handleTouchMove);
    };
  }, [onLook]);

  return (
    <>
      <div
        ref={joystickRef}
        style={{
          position: 'absolute',
          bottom: '20px',
          left: '20px',
          width: '80px',
          height: '80px',
          background: 'rgba(255,255,255,0.2)',
          borderRadius: '50%',
          border: '2px solid rgba(255,255,255,0.5)',
          touchAction: 'none',
        }}
      />
      <div
        ref={lookAreaRef}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          width: '60%',
          height: '100%',
          touchAction: 'none',
        }}
      />
    </>
  );
}

// ---------- Main App ----------
export default function BackroomsScene() {
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 100000));
  const levelData = useMemo(() => generateLevel(seed), [seed]);
  const { rooms, pitfalls, grid, exitPos, startPos } = levelData;
  const [gameStarted, setGameStarted] = useState(false);
  const [victory, setVictory] = useState(false);
  const [falling, setFalling] = useState(false);
  const [creatureActive, setCreatureActive] = useState(false);
  const playerPosRef = useRef(new THREE.Vector3().copy(startPos));
  const keysRef = useRef({ w: false, a: false, s: false, d: false });
  const cameraRef = useRef<any>(null);

  // Keyboard listeners
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'w' || e.key === 'W') keysRef.current.w = true;
      if (e.key === 'a' || e.key === 'A') keysRef.current.a = true;
      if (e.key === 's' || e.key === 'S') keysRef.current.s = true;
      if (e.key === 'd' || e.key === 'D') keysRef.current.d = true;
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'w' || e.key === 'W') keysRef.current.w = false;
      if (e.key === 'a' || e.key === 'A') keysRef.current.a = false;
      if (e.key === 's' || e.key === 'S') keysRef.current.s = false;
      if (e.key === 'd' || e.key === 'D') keysRef.current.d = false;
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Creature delay
  useEffect(() => {
    if (gameStarted && !victory && !falling) {
      const timer = setTimeout(() => setCreatureActive(true), 3000);
      return () => clearTimeout(timer);
    } else {
      setCreatureActive(false);
    }
  }, [gameStarted, victory, falling]);

  const handleMove = useCallback((x: number, z: number) => {
    keysRef.current.a = x < -0.2;
    keysRef.current.d = x > 0.2;
    keysRef.current.w = z < -0.2;
    keysRef.current.s = z > 0.2;
  }, []);

  const handleLook = useCallback((dx: number, dy: number) => {
    if (cameraRef.current) {
      cameraRef.current.moveRight(dx);
      cameraRef.current.moveForward(dy);
    }
  }, []);

  const handleClick = () => setGameStarted(true);

  const handleReset = () => {
    if (cameraRef.current && cameraRef.current.camera) {
      cameraRef.current.camera.position.copy(startPos);
      playerPosRef.current.copy(startPos);
    }
    setFalling(false);
    setCreatureActive(false);
  };

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', touchAction: 'none', background: '#000' }}>
      <Canvas
        camera={{ position: startPos.toArray(), fov: 75 }}
        onCreated={({ camera }) => {
          playerPosRef.current.copy(camera.position);
        }}
      >
        <fog attach="fog" args={['#1a1508', 5, 25]} />
        <ambientLight intensity={0.15} />
        <Level rooms={rooms} pitfalls={pitfalls} exitPos={exitPos} />
        {gameStarted && !victory && (
          <>
            <PointerLockControls ref={cameraRef} />
            <Creature
              playerPosRef={playerPosRef}
              startPos={startPos}
              gameStarted={gameStarted}
              victory={victory}
              setGameStarted={setGameStarted}
              falling={falling}
              creatureActive={creatureActive}
            />
          </>
        )}
        <PlayerMovement
          keysRef={keysRef}
          playerPosRef={playerPosRef}
          exitPos={exitPos}
          setVictory={setVictory}
          gameStarted={gameStarted}
          victory={victory}
          pitfalls={pitfalls}
          rooms={rooms}
          startPos={startPos}
          setFalling={setFalling}
          falling={falling}
          grid={grid}
        />
      </Canvas>

      {!gameStarted && (
        <div
          onClick={handleClick}
          style={{
            position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
            background: 'rgba(0,0,0,0.85)', color: '#d4b85a',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', zIndex: 10, fontSize: '2rem', fontFamily: 'monospace',
          }}
        >
          <div style={{ fontSize: '3rem', marginBottom: '20px' }}>🏢</div>
          <div>Click to enter the Backrooms</div>
          <div style={{ fontSize: '1rem', color: '#8b7355', marginTop: '15px' }}>
            Watch your step. Not all floors are solid.
          </div>
        </div>
      )}

      {falling && (
        <div
          style={{
            position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
            background: 'rgba(0,0,0,0.95)', color: '#8b0000',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            zIndex: 10, fontSize: '2rem', fontFamily: 'monospace',
          }}
        >
          <div style={{ fontSize: '3rem', marginBottom: '20px' }}>🕳️</div>
          <div>You fell into the void...</div>
        </div>
      )}

      {victory && (
        <div
          style={{
            position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
            background: 'rgba(0,0,0,0.8)', color: '#33ff33',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            zIndex: 10, fontSize: '3rem', fontFamily: 'monospace',
          }}
        >
          🎉 You Escaped! 🎉
          <button
            onClick={() => {
              setSeed(Math.floor(Math.random() * 100000));
              setGameStarted(false);
              setVictory(false);
              setFalling(false);
            }}
            style={{ marginTop: '20px', fontSize: '1.5rem', padding: '10px 20px' }}
          >
            New Level
          </button>
        </div>
      )}

      {/* HUD */}
      <div
        style={{
          position: 'absolute', bottom: '20px', left: '20px',
          color: '#8b7355', fontSize: '14px', background: 'rgba(0,0,0,0.6)',
          padding: '6px 14px', borderRadius: '8px', pointerEvents: 'none',
          border: '1px solid #3a3020',
        }}
      >
        <div>WASD move, mouse look | Seed: {seed}</div>
        <div style={{ fontSize: '11px', color: '#5a4a3a', marginTop: '4px' }}>
          ⚠️ Beware of dark square holes in the floor
        </div>
        {!creatureActive && gameStarted && !victory && (
          <div style={{ color: '#5a4a3a', marginTop: '4px' }}>Creature arrives in 3s...</div>
        )}
        <div style={{ pointerEvents: 'auto', marginTop: '8px' }}>
          {gameStarted && !victory && !falling && (
            <button
              onClick={handleReset}
              style={{
                marginRight: '8px', background: '#3a3020', color: '#d4b85a',
                border: '1px solid #5a4a3a', padding: '4px 12px', borderRadius: '4px',
                cursor: 'pointer', fontFamily: 'monospace',
              }}
            >
              Reset
            </button>
          )}
          <button
            onClick={() => {
              setSeed(Math.floor(Math.random() * 100000));
              setGameStarted(false);
              setVictory(false);
              setFalling(false);
            }}
            style={{
              background: '#3a3020', color: '#d4b85a',
              border: '1px solid #5a4a3a', padding: '4px 12px', borderRadius: '4px',
              cursor: 'pointer', fontFamily: 'monospace',
            }}
          >
            New Level
          </button>
        </div>
      </div>

      {gameStarted && !victory && !falling && (
        <MobileControls onMove={handleMove} onLook={handleLook} />
      )}
    </div>
  );
}
