import type { IncomingMessage, ServerResponse } from "node:http";

export type MusicNext = () => void;
export type MusicMiddleware = (req: IncomingMessage, res: ServerResponse, next: MusicNext) => void;

export function createMusicMiddleware(musicRoot: string): MusicMiddleware;
