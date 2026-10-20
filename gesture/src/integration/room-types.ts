export interface RoomRecord {
  id: string;
  name: string;
  kind: 'example' | 'imported';
  createdAt: number;
  updatedAt: number;
  openedAt?: number;
  objectCount: number;
  cover: 'office' | 'bedroom';
  layoutId?: string;
  legacyLayout?: boolean;
}

export interface LocalSession {
  csrf: string;
  nonce: string;
  clientId: string;
  user: {name: string; email: string} | null;
}
