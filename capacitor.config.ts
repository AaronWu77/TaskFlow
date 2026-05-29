import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // Must be a unique reverse-domain identifier. Change 'yourname' to your own handle.
  appId: 'com.yourname.taskflow',
  appName: 'TaskFlow',
  webDir: 'dist',
  // Keep the splash screen hidden until the web layer is ready
  plugins: {
    SplashScreen: {
      launchShowDuration: 0,
      backgroundColor: '#4f46e5',
    },
  },
  ios: {
    // Enables the WKWebView to use safe area environment variables
    contentInset: 'always',
    backgroundColor: '#f4f5f7',
  },
};

export default config;
