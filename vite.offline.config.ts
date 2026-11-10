import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],build:{outDir:'offline-dist',emptyOutDir:true,rollupOptions:{input:'offline.html'}}});
