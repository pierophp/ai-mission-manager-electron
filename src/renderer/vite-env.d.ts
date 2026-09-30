/// <reference types="vite/client" />

interface Window {
  desktop?: {
    versions: {
      electron: string;
      chrome: string;
      node: string;
    };
  };
}
