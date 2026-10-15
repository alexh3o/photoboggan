import { defineConfig } from 'vite';

export default defineConfig({
  // Empêche Vite de nettoyer le terminal (pour voir les erreurs Rust si besoin)
  clearScreen: false,
  server: {
    // Port standard utilisé par Vite
    port: 5173,
    strictPort: true,
    // La ligne magique qui règle ton problème EBUSY sur Windows :
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});