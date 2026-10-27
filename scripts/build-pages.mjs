import {cp,rm} from 'node:fs/promises';
await rm(new URL('../docs/',import.meta.url),{recursive:true,force:true});
await cp(new URL('../dist/',import.meta.url),new URL('../docs/',import.meta.url),{recursive:true});
console.log('GitHub Pages assets written to docs/');
