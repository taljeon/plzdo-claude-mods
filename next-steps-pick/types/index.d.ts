export type Step = { label: string; prompt: string }

declare module 'claude-code' {
  interface PluginState {
    // picked: the index last put in the prompt box, -1 for none.
    'next-steps-pick': { steps: Step[]; picked: number }
  }
}
