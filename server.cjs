const { exec } = require('child_process');

(async () => {
  await import('./server.js');

  const url = 'http://localhost:3000';
  const openBrowser = () => {
    if (process.platform === 'win32') {
      exec(`start "" "${url}"`);
    } else if (process.platform === 'darwin') {
      exec(`open "${url}"`);
    } else {
      exec(`xdg-open "${url}"`);
    }
  };

  setTimeout(openBrowser, 2000);
})();