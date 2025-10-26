
export type AppMode = 'Welcome' | 'Chat' | 'Talk';

export interface Message {
  id: string;
  text: string;
  sender: 'user' | 'bot';
  sources?: GroundingSource[];
  reaction?: string;
}

export interface GroundingSource {
    uri: string;
    title: string;
}