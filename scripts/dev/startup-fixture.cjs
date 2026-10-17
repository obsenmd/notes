// A hidden cold-start fixture without post-startup navigation or trust actions.
const path = require('node:path');
const electron = require('electron');
const {app, BrowserWindow} = electron;
process.on('uncaughtException',error=>{console.error(error.stack);app.exit(1);});
process.on('unhandledRejection',error=>{console.error(error?.stack??error);app.exit(1);});
electron.dialog.showErrorBox=(title,detail)=>{console.error(title,detail);app.exit(1);};
const directory = process.env.OBSEN_STARTUP_FIXTURE;
if (!directory || !path.isAbsolute(directory)) throw new Error('Absolute fixture directory required');
const NativeBrowserWindow = BrowserWindow;
app.setPath('userData',path.join(directory,'profile'));
app.commandLine.appendSwitch('remote-debugging-port',process.env.OBSEN_STARTUP_PORT);
require('./fixture-crash-diagnostics.cjs')(electron,directory);
require('./fixture-deep-links.cjs')(electron, directory);
const shadow=Object.create(electron);
require('./fixture-external-urls.cjs')(shadow,electron);
Object.defineProperty(shadow,'BrowserWindow',{value:class BrowserWindow extends NativeBrowserWindow{
 constructor(options){super({...options,width:1280,height:900,show:false,focusable:false,webPreferences:{...options.webPreferences,offscreen:true,backgroundThrottling:false}});}
}});
const Module=require('node:module'),load=Module._load;
Module._load=function(id,...args){return id==='electron'?shadow:load.call(this,id,...args);};
app.on('browser-window-created',(_event,win)=>{win.show=win.showInactive=win.focus=()=>{};win.webContents.setBackgroundThrottling(false);});
app.on('web-contents-created',(_event,contents)=>{
 contents.on('console-message',details=>{if(details.level==='error')console.error(details.message);});
 contents.on('did-fail-load',(_event,code,description)=>console.error('Load',code,description));
});
process.argv=[process.argv[0],process.cwd(),'--vault',path.join(directory,'vault')];
const runtime=path.resolve(process.env.OBSEN_DIST??'dist','app.asar','main.cjs');
require(runtime);
