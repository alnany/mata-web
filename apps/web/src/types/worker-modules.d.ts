/** Vite `?worker` import — typed so TS knows the default export is a Worker ctor. */
declare module '*?worker' {
  const ctor: new () => Worker;
  export default ctor;
}

declare module '@mata/worker-matrix?worker' {
  const ctor: new () => Worker;
  export default ctor;
}
