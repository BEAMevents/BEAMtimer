// Renders build/icon.png and public/icon.png (the page icon).
// Run: ../BEAMpi/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron build/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

// A stopwatch and a running-down progress bar above the BEAM wordmark, like the other BEAM icons.
const html = `<html><body style="margin:0;background:transparent">
<div style="width:512px;height:512px;border-radius:96px;background:linear-gradient(160deg,#FF7A2E,#E04E00);
  display:flex;flex-direction:column;justify-content:flex-end;padding:0 52px 58px;box-sizing:border-box;
  font-family:Arial,Helvetica,sans-serif;color:#fff">
  <div style="position:relative;height:84px;margin-bottom:30px">
    <div style="position:absolute;left:30px;top:-8px;width:24px;height:14px;background:#fff;border-radius:5px"></div>
    <div style="position:absolute;left:0;top:8px;width:84px;height:84px;border:14px solid #fff;border-radius:50%;box-sizing:border-box"></div>
    <div style="position:absolute;left:36px;top:28px;width:12px;height:28px;background:#fff;border-radius:6px"></div>
    <div style="position:absolute;left:112px;top:40px;width:296px;height:20px;background:rgba(255,255,255,.35);border-radius:10px">
      <div style="width:62%;height:100%;background:rgba(255,255,255,.85);border-radius:10px"></div>
    </div>
  </div>
  <div style="font-weight:700;font-size:142px;line-height:.9;letter-spacing:-4px">BEAM</div>
  <div style="font-weight:400;font-size:78px;line-height:1;letter-spacing:0px;margin-top:6px">timer</div>
</div></body></html>`;

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, useContentSize: true });
  await w.loadURL('data:text/html,' + encodeURIComponent(html));
  await new Promise(r => setTimeout(r, 300));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  const png = img.resize({ width: 512, height: 512 }).toPNG();
  fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
  fs.writeFileSync(path.join(__dirname, '..', 'public', 'icon.png'), png);
  app.exit(0);
});
