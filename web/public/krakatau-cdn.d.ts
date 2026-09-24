// Lets TypeScript type-check imports straight from jsDelivr, using the types from the npm package
// (install it as a devDependency just for its types: npm i -D krakatau-web).
declare module 'https://cdn.jsdelivr.net/npm/krakatau-web@*/krak-client.mjs' {
  export * from 'krakatau-web';
}
