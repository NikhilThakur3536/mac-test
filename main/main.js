const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const store = require('electron-settings');
const path = require('path');
const { GlobalKeyboardListener } = require('node-global-key-listener');
const moment = require('moment');
const { uIOhook, UiohookKey } = require('uiohook-napi');



// API
const { default: axios } = require('axios');

const IS_PRODUCTION = false;
const API_BASE_URL = `https://webtracker${IS_PRODUCTION ? 'prod' : ''}.infoware.xyz/api`;

let mainWindow;
let isLogging = false;
let screenshotInterval;
let captureIntervalMinutes;
let activityIntervalMinutes;
let activitySpeedLocationInterval;
let activityReportInterval;

// Activities
let clickCount = 0;
let keyCount = 0;
let accumulatedText = '';

// Idle time
let lastActivityTime = Date.now();
let lastIdleCheckTime = Date.now();
let accumulatedIdleTime = 0;
let idleInterval;

let ownerId = null;
let authToken = null;
let projectTaskActivityId = null;

// Active window tracking
let lastActiveWindow = null;
let appWebsites = [];
let appWebsiteDetails = [];

// Stats

let initialStats = {
  clickCount: 0,
  keyCount: 0,
  idleTime: 0,
  accumulatedText: '',
  lastActive: '',
  appWebsites: [],
  appWebsiteDetails: [],
};

let stats = initialStats;

ipcMain.on('set-user-data', async (event, data) => {
  try {
    authToken = data.authToken;
    if (authToken) {
      await store.set('authToken', authToken);
      await fetchCaptureInterval();
    }
  } catch (error) {
    console.error('Failed to set user data:', error);
    event.reply('set-user-data-error', {
      success: false,
      error: error.message,
    });
  }
});

ipcMain.handle('set-activity-data', async (event, data) => {
  try {
    ownerId = data.ownerId;
    projectTaskActivityId = data.projectTaskActivityId;

    await store.set('ownerId', ownerId);
    await store.set('projectTaskActivityId', projectTaskActivityId);

    return { success: true };
  } catch (error) {
    console.error('Failed to set activity data:', error);
    return { success: false, error: error.message };
  }
});

// Function to fetch capture interval from API
ipcMain.on('fetch-capture-interval', async (event) => {
  event.sender.send('capture-interval', captureIntervalMinutes);
});

// Function to fetch activity interval from API
ipcMain.on('fetch-activity-interval', async (event) => {
  event.sender.send('activity-interval', activityIntervalMinutes);
});

ipcMain.on('fetch-activity-speed-location-interval', async (event) => {
  event.sender.send(
    'activity-speed-location-interval',
    activitySpeedLocationInterval
  );
});

ipcMain.on('fetch-activity-report-interval', async (event) => {
  event.sender.send('activity-report-interval', activityReportInterval);
});

async function fetchCaptureInterval() {
  try {
    const response = await axios.post(
      `${API_BASE_URL}/employee/auth/configuration/get`,
      {},
      {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    // 1) Screenshot capture interval
    captureIntervalMinutes =
      response?.data?.data?.screenshotIntervalInSeconds / 60;

    // 2) Activity interval
    activityIntervalMinutes =
      response?.data?.data?.activityDetailIntervalInSeconds / 60;

    // 3) Speed location interval
    activitySpeedLocationInterval =
      response?.data?.data?.internetSpeedIntervalInSeconds;

    // 4) Report Iinterval
    activityReportInterval =
      response?.data?.data?.activityReportIntervalInSeconds;

    if (mainWindow) {
      mainWindow.webContents.send(
        'capture-interval',
        captureIntervalMinutes?.toFixed(1) || 5
      );
      mainWindow.webContents.send(
        'acitivity-interval',
        activityIntervalMinutes || 1
      );
      mainWindow.webContents.send(
        'activity-speed-location-interval',
        +activitySpeedLocationInterval || 2000
      );
      mainWindow.webContents.send(
        'activity-report-interval',
        +activityReportInterval || 900
      );
    }

    return captureIntervalMinutes;
  } catch (error) {
    console.error('Error fetching capture interval:', error);
    return null;
  }
}

// Create main application window
async function createWindow() {
  const isDev = await import('electron-is-dev').then(
    (module) => module.default
  );

  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    simpleFullscreen: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(
    isDev
      ? 'http://localhost:3000'
      : `file://${path.join(__dirname, '../out/index.html')}`
  );

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const storeToken = await store.get('authToken');

  if (storeToken) {
    authToken = storeToken;
    await fetchCaptureInterval();
    await loadStats();
  }

  setTimeout(() => {
    mainWindow.webContents.send('update-stats', stats);
  }, 500);

  // if (isDev) {
  mainWindow.webContents.openDevTools();
  // }
}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

async function getActiveWindowInfo() {
  try {
    const { activeWindow } = await import('get-windows');
    const window = await activeWindow();
    if (window) {
      return {
        platform: window?.platform,
        name: window.owner.name,
        title: window.title,
        memoryUsage: window?.memoryUsage,
        time: new Date().toISOString(),
      };
    }
  } catch (error) {
    console.error('Error getting active window info:', error);
  }
  return null;
}

// Function to update and send stats
async function updateStats(isActivity = false) {
  const currentTime = Date.now();

  if (!isActivity) {
    // Calculate idle time since last check
    const idleTime = Math.floor((currentTime - lastIdleCheckTime) / 60000); // Convert to minutes
    accumulatedIdleTime += idleTime;
    lastIdleCheckTime = currentTime; // Update last idle check time
  } else {
    // Reset last idle check time when there's activity
    lastIdleCheckTime = currentTime;
    lastActivityTime = currentTime;
  }

  const activeWindow = await getActiveWindowInfo();

  if (
    activeWindow &&
    activeWindow.name?.toLowerCase().trim() !== 'electron' &&
    (lastActiveWindow === null ||
      activeWindow.name !== lastActiveWindow.name ||
      activeWindow.title !== lastActiveWindow.title)
  ) {
    if (
      lastActiveWindow === null ||
      !appWebsites?.includes(activeWindow?.name)
    ) {
      appWebsites?.unshift(activeWindow?.name);
    }
    appWebsiteDetails?.unshift(activeWindow);

    lastActiveWindow = activeWindow;
  }

  stats = {
    clickCount,
    keyCount,
    idleTime: accumulatedIdleTime,
    accumulatedText,
    lastActive: moment(lastActivityTime).format('hh:mm:ss A'),
    appWebsites,
    appWebsiteDetails,
  };

  mainWindow.webContents.send('update-stats', stats);
  saveStats(stats);

  // Clear existing interval and start a new one
  clearInterval(idleInterval);
  startIdleTracking();
}

// Function to start idle tracking
function startIdleTracking() {
  idleInterval = setInterval(() => {
    if (isLogging) {
      updateStats();
    }
  }, 60000); // Check every minute
}

// // Set up global keyboard listener
// const keyboardListener = new GlobalKeyboardListener();
// keyboardListener.addListener((e) => {
//   if (isLogging && !mainWindow.isFocused()) {
//     if (e.name === 'MOUSE LEFT' || e.name === 'MOUSE RIGHT') {
//       if (e.state === 'UP') {
//         clickCount++;
//       }
//     } else {
//       if (e.state === 'DOWN') {
//         keyCount++;
//         accumulatedText +=
//           e.name === 'SPACE'
//             ? ' '
//             : e.name.length === 1
//               ? e.name?.toLowerCase()
//               : '';
//       }
//     }

//     updateStats(true);
//   }
// });

{/*Key mapped to every alphabets add more mapping if you want*/}
const keyMap = {
  [UiohookKey.A]: 'a',
  [UiohookKey.B]: 'b',
  [UiohookKey.C]: 'c',
  [UiohookKey.D]: 'd',
  [UiohookKey.E]: 'e',
  [UiohookKey.F]: 'f',
  [UiohookKey.G]: 'g',
  [UiohookKey.H]: 'h',
  [UiohookKey.I]: 'i',
  [UiohookKey.J]: 'j',
  [UiohookKey.K]: 'k',
  [UiohookKey.L]: 'l',
  [UiohookKey.M]: 'm',
  [UiohookKey.N]: 'n',
  [UiohookKey.O]: 'o',
  [UiohookKey.P]: 'p',
  [UiohookKey.Q]: 'q',
  [UiohookKey.R]: 'r',
  [UiohookKey.S]: 's',
  [UiohookKey.T]: 't',
  [UiohookKey.U]: 'u',
  [UiohookKey.V]: 'v',
  [UiohookKey.W]: 'w',
  [UiohookKey.X]: 'x',
  [UiohookKey.Y]: 'y',
  [UiohookKey.Z]: 'z',
};

// Keyboard event listener
uIOhook.start()

uIOhook.on('keydown', (e) => {
  if (!isLogging) return;
console.log(isLogging)
  keyCount++;
  if (e.keycode === UiohookKey.Space) {
    accumulatedText += ' ';
  }
  else if (keyMap[e.keycode]) {
    const char = keyMap[e.keycode];
    console.log(char);
    accumulatedText += char;
  }
  updateStats(true);
});
// Mouse events listner
uIOhook.on('mouseup', (e) => {
  if (!isLogging) return;

  clickCount++;
  updateStats(true);
});

// uiohook.start();
// uiohook.addListner('keydown', (e) => {
//   // Check if we are logging and the main window is not focused
//   if (isLogging && !mainWindow.isFocused()) {
//     if (e.keycode === 1 || e.keycode === 3) { // Mouse Left and Right
//       if (e.event === 'up') {
//         clickCount++;dved
//       }
//     } else {
//       if (e.event === 'down') {
//         keyCount++;
//         accumulatedText +=
//           e.keycode === 57 // Space key
//             ? ' '
//             : String.fromCharCode(e.keycode).toLowerCase();
//       }
//     }

//     updateStats();
//   }
// });


// Function to capture and save screenshot
async function captureAndSaveScreenshot() {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    });
    const primaryDisplay = sources[0];

    if (primaryDisplay) {
      const screenshotBuffer = primaryDisplay.thumbnail.toPNG();
      const fileName = `Screenshot_${moment().format(
        'YYYY-MM-DD_HH-mm-ss'
      )}.png`;

      const screenshotBlob = new Blob([screenshotBuffer], {
        type: 'image/png',
      });

      const file = new File([screenshotBlob], fileName, { type: 'image/png' });

      const formData = new FormData();
      formData.append('files', file);

      authToken = authToken || (await store.get('authToken'));
      ownerId = ownerId || (await store.get('ownerId'));
      projectTaskActivityId =
        projectTaskActivityId || (await store.get('projectTaskActivityId'));

      if (!ownerId || !authToken) {
        throw new Error('ownerId or authToken not set');
      }
      formData.append('ownerId', ownerId);

      const response = await axios.post(
        `${API_BASE_URL}/employee/media/add`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'multipart/form-data',
          },
        }
      );

      const mediaId = await response?.data?.data?.[0]?.id;

      const payload = {
        ownerId,
        projectTaskActivityId,
        mediaId,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };

      await axios.post(
        `${API_BASE_URL}/employee/project/project/task/activity/screenshot/add`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        }
      );
    }
  } catch (error) {
    console.error('Error capturing or uploading screenshot:', error);
  }
}
// Function to start screenshot capture
async function startScreenshotCapture() {
  if (screenshotInterval) {
    stopScreenshotCapture();
  }

  screenshotInterval = setInterval(
    captureAndSaveScreenshot,
    captureIntervalMinutes * 60 * 1000
  );
}

// Function to stop screenshot capture
function stopScreenshotCapture() {
  clearInterval(screenshotInterval);
}

// IPC handlers
ipcMain.handle('start-logging', async () => {
  isLogging = true;
  clickCount = 0;
  keyCount = 0;
  accumulatedText = '';
  accumulatedIdleTime = 0;
  lastActivityTime = Date.now();
  lastIdleCheckTime = Date.now();
  lastActiveWindow = null;
  appWebsites = [];
  appWebsiteDetails = [];
  startIdleTracking();
  await startScreenshotCapture();
});

ipcMain.handle('restart-logging', async () => {
  authToken = await store.get('authToken');
  ownerId = await store.get('ownerId');
  projectTaskActivityId = await store.get('projectTaskActivityId');
  const savedStats = await store.get('stats');

  isLogging = true;
  clickCount = savedStats.clickCount;
  keyCount = savedStats.keyCount;
  accumulatedText = savedStats.accumulatedText;
  accumulatedIdleTime = savedStats.idleTime;
  lastActivityTime = Date.now();
  lastIdleCheckTime = Date.now();
  lastActiveWindow = await getActiveWindowInfo();
  appWebsites = savedStats.appWebsites;
  appWebsiteDetails = savedStats.appWebsiteDetails;
  startIdleTracking();
  await startScreenshotCapture();
});

ipcMain.handle('clear-store-stats', async () => {
  await store.set('stats', initialStats);
});

ipcMain.handle('get-location', async () => {
  let location = null;
  try {
    const response = await axios.get('http://ip-api.com/json/');
    location = {
      latitude: response.data.lat,
      longitude: response.data.lon,
      city: `${response.data.city}, ${response.data.country}`,
    };
  } catch (error) {
    console.error('Failed to fetch location:', error.message);
  }

  return location;
});

ipcMain.on('stop-logging', () => {
  isLogging = false;
  clearInterval(idleInterval);
  stopScreenshotCapture();
  stats = initialStats;
});

ipcMain.handle('get-initial-stats', async () => {
  return stats;
});

function saveStats(stats) {
  store.set('stats', stats);
}

async function loadStats() {
  const savedStats = await store.get('stats');
  if (savedStats) {
    stats = savedStats;
    clickCount = stats.clickCount;
    keyCount = stats.keyCount;
    accumulatedIdleTime = stats.idleTime;
    accumulatedText = stats.accumulatedText;
    lastActivityTime = Date.now();
    appWebsites = stats.appWebsites;
    appWebsiteDetails = stats.appWebsiteDetails;
  } else {
    stats = initialStats;
  }
}

async function clearRendererStorage() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.webContents.session.clearStorageData({
      storages: ['localStorage'],
    });
  }
}

app.on('will-uninstall', async (event) => {
  event.preventDefault();
  try {
    await clearRendererStorage();
  } catch (error) {
    console.error('Error clearing renderer storage:', error);
  }
  event.continue();
});