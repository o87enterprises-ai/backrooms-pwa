// Minimal generator for testing

export interface Room {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  type: 'room' | 'corridor';
}

export function generateLevel(seed: number = Date.now()): Room[] {
  return [
    { x: 10, z: 10, width: 4, depth: 4, height: 3, type: "room" },
    { x: 14, z: 10, width: 2, depth: 2, height: 3, type: "room" },
  ];
}
