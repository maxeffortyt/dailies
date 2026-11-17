// Every `import ... from "remotion"` in your film (and inside @remotion/player) lands here.
// It is the real remotion, except for registerRoot, <Composition>, <Still> and <Folder>:
// Dailies records those so it can play each composition in @remotion/player, live from your code.
export * from "dailies:real-remotion";
import React, { createContext, useContext, useLayoutEffect } from "react";

export type Registered = {
  id: string;
  component?: React.ComponentType<Record<string, unknown>>;
  lazyComponent?: () => Promise<{ default: React.ComponentType<Record<string, unknown>> }>;
  durationInFrames?: number;
  fps?: number;
  width?: number;
  height?: number;
  defaultProps?: Record<string, unknown>;
  calculateMetadata?: (o: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
  still: boolean;
  folder: string | null;
};

export const CollectorContext = createContext<{ add: (c: Registered) => void } | null>(null);
const FolderContext = createContext<string | null>(null);
const g = globalThis as unknown as { __dailiesRoot?: React.FC };

export const registerRoot = (root: React.FC) => {
  g.__dailiesRoot = root;
};

export const Folder: React.FC<{ name: string; children?: React.ReactNode }> = ({ name, children }) => {
  const parent = useContext(FolderContext);
  return <FolderContext.Provider value={parent ? `${parent}/${name}` : name}>{children}</FolderContext.Provider>;
};

const useRegister = (props: Record<string, unknown>, still: boolean) => {
  const collector = useContext(CollectorContext);
  const folder = useContext(FolderContext);
  useLayoutEffect(() => {
    collector?.add({ ...(props as unknown as Registered), still, folder, ...(still ? { durationInFrames: 1, fps: (props.fps as number) ?? 30 } : {}) });
  });
};

export const Composition = (props: Record<string, unknown>) => {
  useRegister(props, false);
  return null;
};
export const Still = (props: Record<string, unknown>) => {
  useRegister(props, true);
  return null;
};
