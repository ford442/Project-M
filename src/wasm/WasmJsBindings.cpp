// WasmJsBindings.cpp
//
// EM_JS clusters: host-page DOM/VFS bootstrap (js_init_projectm_dom), preset
// download helpers, and the preset-name / init-error / preset-switch-failure
// notifications back to the host page.
//
// These blocks run in the render worker too (OffscreenCanvas path), where there
// is no `window` and no `document`. So: host hooks are read off `globalThis`,
// which is the actual contract with the page, and every block that needs the
// DOM resolves `globalThis.document` once into `pmDoc` and returns early when
// it is absent, instead of throwing on first dereference.
#include "ProjectMWasmInternal.hpp"

// clang-format off
EM_JS(void, js_update_preset_name, (const char* name), {
    const presetName = UTF8ToString(name);
    if (globalThis.updatePresetDisplay) {
        globalThis.updatePresetDisplay(presetName);
    }
});
// clang-format on

// Surfaces a preset-switch failure to the host page via the #stat readout (if present),
// so users see something other than a silently frozen preset. Falls back to console.warn.
// clang-format off
EM_JS(void, js_report_preset_switch_failed, (const char* preset_filename, const char* message), {
    const name = preset_filename ? UTF8ToString(preset_filename) : '(unknown preset)';
    const msg = message ? UTF8ToString(message) : '';
    globalThis.projectMPresetSwitchFailed = true;
    globalThis.projectMPresetSwitchFailure = { preset: name, message: msg };
    console.warn('[projectM] preset switch failed (' + name + '): ' + msg);
    const pmDoc = globalThis.document;
    const statEl = pmDoc ? pmDoc.querySelector('#stat') : null;
    if (statEl) {
        statEl.innerHTML = 'Preset failed: ' + name.split('/').pop();
        statEl.style.backgroundColor = 'red';
    }
});
// clang-format on

// clang-format off
EM_JS(void,getCustomShader,(),{
var pmDoc=globalThis.document;
if(!pmDoc){ return; }
var pathEl=pmDoc.querySelector('#milkPath2');
if(!pathEl){ return; }
var pth=pathEl.innerHTML;
var presetName = pth.split('/').pop();
if (globalThis.updatePresetDisplay) { globalThis.updatePresetDisplay(presetName); }
console.log('Getting preset: '+pth);
const ff=new XMLHttpRequest();
ff.open('GET',pth,true);
ff.responseType='arraybuffer';
var statEl5 = pmDoc.querySelector('#stat');
if (statEl5) { statEl5.innerHTML='Downloading Shader'; statEl5.style.backgroundColor='yellow'; }
ff.addEventListener("load",function(){
let sarrayBuffer=ff.response;
if(sarrayBuffer){
let sfil=new Uint8ClampedArray(sarrayBuffer);
FS.writeFile("/presets/preset_custom.milk",sfil);
setTimeout(function(){
Module.ccall('load_preset_file', null, ['string'], ["/presets/preset_custom.milk"]);
var statEl6 = pmDoc.querySelector('#stat');
if (statEl6) { statEl6.innerHTML='Downloaded Shader'; statEl6.style.backgroundColor='blue'; }
},20);
}
});
ff.send(null);
return;
});
// clang-format on

// clang-format off
EM_JS(void,getShader,(int num),{
var pmDoc=globalThis.document;
if(!pmDoc){ return; }
var pathEl=pmDoc.querySelector('#milkPath');
if(!pathEl){ return; }
var pth=pathEl.innerHTML;
var presetName = pth.split('/').pop();
if (globalThis.updatePresetDisplay) { globalThis.updatePresetDisplay(presetName); }
console.log('Getting preset: '+pth);
const ff=new XMLHttpRequest();
ff.open('GET',pth,true);
ff.responseType='arraybuffer';
var statEl5 = pmDoc.querySelector('#stat');
if (statEl5) { statEl5.innerHTML='Downloading Shader'; statEl5.style.backgroundColor='yellow'; }
ff.addEventListener("load",function(){
let sarrayBuffer=ff.response;
if(sarrayBuffer){
let sfil=new Uint8ClampedArray(sarrayBuffer);
FS.writeFile("/presets/preset_"+num+".milk",sfil);
setTimeout(function(){
pmDoc.querySelector('#stat').innerHTML='Downloaded Shader';
pmDoc.querySelector('#stat').style.backgroundColor='blue';
},20);
}
});
ff.send(null);
return;
});
// clang-format on

// clang-format off
EM_JS(void, js_init_projectm_dom, (), {
var pmDoc = globalThis.document;
if (!pmDoc) {
    // Render worker / non-DOM host: nothing here applies, and the VFS bootstrap
    // is the host page's job in that topology.
    return;
}
if (globalThis.projectMDOMInitialized) return;
globalThis.projectMDOMInitialized = true;
var isCaptureMode = globalThis.__projectMCaptureMode === true;
var isWeeksOnFire = globalThis.__projectMWeeksOnFire === true;
try {
    var params = new URLSearchParams(globalThis.location.search || '');
    isCaptureMode = isCaptureMode || params.get('capture') === '1' || params.get('capture') === 'true';
    isWeeksOnFire = isWeeksOnFire || params.get('mode') === 'weeks_on_fire';
} catch (e) {}
if (isWeeksOnFire) {
    globalThis.__projectMWeeksOnFire = true;
}

function vfsPathExists(path) {
    try {
        FS.stat(path);
        return true;
    } catch (e) {
        return false;
    }
}

function vfsMkdir(path) {
    try {
        FS.mkdir(path);
    } catch (e) {
        // Ignore if already exists or other FS errors
    }
}

vfsMkdir('/presets');
vfsMkdir('/textures');
vfsMkdir('/snd');
// Canvas sizing is handled by the JS ResizeObserver before init();
// Do not clobber it here.
var $sngs=[];
var $shds=[];
var $texs=[];
var $customMilk=[];
var $weeksPresets=[];

function getBasePath(id, fallback) {
    var el = pmDoc.querySelector(id);
    if (el && el.innerHTML && el.innerHTML.trim().length > 0) {
        var path = el.innerHTML.trim();
        if (path.charAt(path.length - 1) !== '/') {
            path += '/';
        }
        return path;
    }
    return fallback;
}

function textures(xml, textureBase){
    const nparser = new DOMParser();
    const htmlDocs = nparser.parseFromString(xml.responseText, 'text/html');
    const preList = htmlDocs.getElementsByTagName('pre')[0].getElementsByTagName('a');
    $texs[0] = preList.length;
    console.log('scanned: ' + $texs[0] + ' textures from ' + textureBase);
    for (var i = 5; i < preList.length; i++) {
        var fname = preList[i].getAttribute('href');
        var fileName = preList[i].innerText.trim();
        var fullUrl = new URL(fname, textureBase).href;
        $texs[i] = fullUrl;
        console.log('$texs[' + i + ']: ', $texs[i]);
        (function(filename, url) {
            const ff = new XMLHttpRequest();
            ff.open('GET', url, true);
            ff.responseType = 'arraybuffer';
            var statEl = pmDoc.querySelector('#stat');
            if (statEl) { statEl.innerHTML = 'Downloading Texture'; statEl.style.backgroundColor = 'yellow'; }
            ff.addEventListener("load", function(){
                let sarrayBuffer = ff.response;
                if (sarrayBuffer) {
                    let sfil = new Uint8ClampedArray(sarrayBuffer);
                    FS.writeFile("/textures/" + filename, sfil);
                    console.log('got texture: ' + filename + ' from ' + url);
                    setTimeout(function(){
                        var statEl2 = pmDoc.querySelector('#stat');
                        if (statEl2) { statEl2.innerHTML = 'Downloaded Texture'; statEl2.style.backgroundColor = 'blue'; }
                    }, 500);
                }
            });
            ff.send(null);
        })(fileName, fullUrl);
    }
}

function scanTextures(){
    var textureBase = getBasePath('#textureDir', 'textures/');
    if (!textureBase.startsWith('http://') && !textureBase.startsWith('https://')) {
        textureBase = new URL(textureBase, globalThis.location.href).href;
    }
    const nxhttp = new XMLHttpRequest();
    nxhttp.onreadystatechange = function(){
        if (this.readyState == 4 && this.status == 200) {
            console.log('scanning textures from: ' + textureBase);
            textures(this, textureBase);
        }
    };
    nxhttp.open('GET', textureBase, true);
    nxhttp.send();
}

function customMilkShds(xml){
const nparser=new DOMParser();
const htmlDocs=nparser.parseFromString(xml.responseText,'text/html');
const preList=htmlDocs.getElementsByTagName('pre')[0].getElementsByTagName('a');
var baseUrl='https://glsl.1ink.us/custom_milk/';
$customMilk=[];
for(var i=0;i<preList.length;i++){
var txxt=preList[i].getAttribute('href');
var fullUrl=new URL(txxt,baseUrl).href;
if(fullUrl.indexOf('.milk')!==-1){
$customMilk.push(fullUrl);
}
}
console.log('Scanned '+$customMilk.length+' custom milk presets.');
if($customMilk.length>0){
setTimeout(function(){ getCustomMilkShaders(); },3000);
}
}

function scanCustomMilk(){
const nxhttp=new XMLHttpRequest();
nxhttp.onreadystatechange=function(){
if(this.readyState==4&&this.status==200){ customMilkShds(this); }
};
nxhttp.open('GET','https://glsl.1ink.us/custom_milk/',true);
nxhttp.send();
}

function getCustomMilkShaders(){
var completed=0;
var total=$customMilk.length;
var statEl3=pmDoc.querySelector('#stat');
if(statEl3){statEl3.innerHTML='Downloading Custom Presets';statEl3.style.backgroundColor='yellow';}
for(var i=0;i<total;i++){
(function(src,idx){
const ff=new XMLHttpRequest();
ff.open('GET',src,true);
ff.responseType='arraybuffer';
ff.addEventListener("load",function(){
var buf=ff.response;
if(buf){
FS.writeFile("/presets/custmilk_"+idx+".milk",new Uint8ClampedArray(buf));
console.log('Got custom preset: custmilk_'+idx+'.milk from '+src);
}
completed++;
if(completed===total){
console.log('Custom milk presets downloaded (not adding to auto-change playlist).');
if(statEl3){statEl3.innerHTML='Custom Presets Ready';statEl3.style.backgroundColor='blue';}
}
});
ff.addEventListener("error",function(){
console.warn('Failed to download custom preset: '+src);
completed++;
if(completed===total){
console.log('Custom milk presets downloaded (not adding to auto-change playlist).');
if(statEl3){statEl3.innerHTML='Custom Presets Ready';statEl3.style.backgroundColor='blue';}
}
});
ff.send(null);
})($customMilk[i],i);
}
}

function loadRandomCustomMilk(){
if($customMilk.length===0){
console.log('No custom milk presets available yet.');
pmDoc.querySelector('#stat').innerHTML='Custom presets loading...';
pmDoc.querySelector('#stat').style.backgroundColor='orange';
return;
}
var idx=Math.floor(Math.random()*$customMilk.length);
var fname='/presets/custmilk_'+idx+'.milk';
var originalName = $customMilk[idx].split('/').pop();
Module.ccall('load_preset_file', null, ['string'], [fname]);
if (globalThis.updatePresetDisplay) { globalThis.updatePresetDisplay(originalName); }
pmDoc.querySelector('#stat').innerHTML='Loaded: custmilk_'+idx+'.milk';
pmDoc.querySelector('#stat').style.backgroundColor='green';
console.log('Loading random custom milk: '+fname);
}

var $milk=[];
var $milkLrg=[];
var $milkMed=[];
var $milkSml=[];

function parseMilkDir(xml,baseUrl,array){
const nparser=new DOMParser();
const htmlDocs=nparser.parseFromString(xml.responseText,'text/html');
const preList=htmlDocs.getElementsByTagName('pre')[0].getElementsByTagName('a');
for(var i=1;i<preList.length;i++){
var txxt=preList[i].getAttribute('href');
var fullUrl=new URL(txxt,baseUrl).href;
array.push(fullUrl);
}
console.log('Scanned '+array.length+' presets from '+baseUrl);
}

function scanMilkDir(url,array,callback){
const nxhttp=new XMLHttpRequest();
nxhttp.onreadystatechange=function(){
if(this.readyState==4&&this.status==200){
parseMilkDir(this,url,array);
if(callback){ callback(); }
}};
nxhttp.open('GET',url,true);
nxhttp.send();
}

function scanWeeksPresets(callback){
if(!isWeeksOnFire){ return; }
var presetBase=getBasePath('#weeksPresetDir','weeks_presets/');
if(!presetBase.startsWith('http://')&&!presetBase.startsWith('https://')){
presetBase=new URL(presetBase,globalThis.location.href).href;
}
scanMilkDir(presetBase,$weeksPresets,callback);
}

var weeksPresetPickInFlight=false;
function loadRandomWeeksPreset(){
if(weeksPresetPickInFlight){
console.log('Weeks preset pick already in flight; ignoring duplicate request.');
return;
}
if($weeksPresets.length===0){
console.log('No weeks presets available yet.');
return;
}
weeksPresetPickInFlight=true;
var url=$weeksPresets[Math.floor(Math.random()*$weeksPresets.length)];
var presetName=url.split('/').pop();
const ff=new XMLHttpRequest();
ff.open('GET',url,true);
ff.responseType='arraybuffer';
var statEl=pmDoc.querySelector('#stat');
if(statEl){statEl.innerHTML='Downloading Weeks Preset';statEl.style.backgroundColor='yellow';}
ff.addEventListener("load",function(){
var buf=ff.response;
weeksPresetPickInFlight=false;
if(buf){
var vfsName='/presets/weeks_pick_'+Date.now()+'.milk';
FS.writeFile(vfsName,new Uint8ClampedArray(buf));
Module.ccall('load_preset_file_hard',null,['string'],[vfsName]);
if(globalThis.updatePresetDisplay){globalThis.updatePresetDisplay(presetName);}
if(statEl){statEl.innerHTML='Loaded: '+presetName;statEl.style.backgroundColor='green';}
}
});
ff.addEventListener("error",function(){
weeksPresetPickInFlight=false;
console.warn('Failed to download weeks preset: '+url);
});
ff.send(null);
}
globalThis.loadRandomWeeksPreset=loadRandomWeeksPreset;

function seedWeeksPresetPlaylist(count){
if($weeksPresets.length===0){ return; }
count=count||5;
var pool=$weeksPresets.slice();
var picks=[];
var want=Math.min(count,pool.length);
for(var n=0;n<want;n++){
var idx=Math.floor(Math.random()*pool.length);
picks.push(pool.splice(idx,1)[0]);
}
var completed=0;
var firstLoaded=false;
for(var i=0;i<picks.length;i++){
(function(url,slot){
const ff=new XMLHttpRequest();
ff.open('GET',url,true);
ff.responseType='arraybuffer';
ff.addEventListener("load",function(){
var buf=ff.response;
if(buf){
var vfsName='/presets/weeks_'+slot+'.milk';
FS.writeFile(vfsName,new Uint8ClampedArray(buf));
if(!firstLoaded){
Module.ccall('load_preset_file',null,['string'],[vfsName]);
if(globalThis.updatePresetDisplay){globalThis.updatePresetDisplay(url.split('/').pop());}
firstLoaded=true;
}else{
Module.ccall('add_preset_file',null,['string'],[vfsName]);
}
}
completed++;
if(completed===picks.length){
console.log('Weeks on fire: seeded '+picks.length+' presets into playlist.');
if(globalThis.__projectMWeeksOnFireResolve){globalThis.__projectMWeeksOnFireResolve();}
}
});
ff.addEventListener("error",function(){
console.warn('Failed to download weeks preset: '+url);
completed++;
});
ff.send(null);
})(picks[i],i);
}
}

function openFlacDecoder(){
if(typeof globalThis.openWeeksFlacDecoder==='function'){
globalThis.openWeeksFlacDecoder();
return;
}
var url=getBasePath('#flacDecoderUrl','./flac/');
if(!url.startsWith('http://')&&!url.startsWith('https://')){
try{url=new URL(url,globalThis.location.href).href;}catch(e){}
}
// New tab (no window features). Sized popups fail under COEP on several hosts.
if(typeof globalThis.open==='function'){ globalThis.open(url,'flac-decoder'); }
}

function autoStartWeeksSong(){
if(!isWeeksOnFire){ return; }
console.log('Weeks on fire: opening same-origin FLAC decoder and queueing a random song.');
openFlacDecoder();
setTimeout(function(){ snd(); },1550);
}

function sngs(xml, songBase){
    const nparser = new DOMParser();
    const htmlDocs = nparser.parseFromString(xml.responseText, 'text/html');
    const pre = htmlDocs.getElementsByTagName('pre')[0];
    if (!pre) {
        console.warn('No directory listing <pre> in', songBase);
        return;
    }
    const preList = pre.getElementsByTagName('a');
    var added = 0;
    for (var i = 0; i < preList.length; i++) {
        var fname = preList[i].getAttribute('href');
        if (!fname || fname === '../' || fname === '/' || fname.startsWith('?')) continue;
        var fullUrl = new URL(fname, songBase).href;
        $sngs.push(fullUrl);
        added++;
    }
    console.log('scanned: ' + added + ' songs from ' + songBase + ' (catalog size ' + $sngs.length + ')');
}

function scanSongDirectory(elementId, fallback){
    var songBase = getBasePath(elementId, fallback);
    if (!songBase) return;
    if (!songBase.startsWith('http://') && !songBase.startsWith('https://')) {
        songBase = new URL(songBase, globalThis.location.href).href;
    }
    const nxhttp = new XMLHttpRequest();
    nxhttp.onreadystatechange = function(){
        if (this.readyState == 4 && this.status == 200) {
            sngs(this, songBase);
        } else if (this.readyState == 4 && this.status !== 200) {
            console.warn('Song scan failed for', songBase, 'status', this.status);
        }
    };
    nxhttp.open('GET', songBase, true);
    nxhttp.send();
}

function scanSongs(){
    $sngs = [];
    scanSongDirectory('#songDir', 'songs/');
    scanSongDirectory('#mp3SongDir', 'mp3_songs/');
    scanSongDirectory('#modSongDir', 'mod_songs/');
}

var lastSongFileName = '';

const fll = new BroadcastChannel('file');
fll.addEventListener('message', ea => {
    const uniqueFileName = `/snd/song_${Date.now()}.wav`;
    console.log(`JS Event: Received new song. Writing to unique path: ${uniqueFileName}`);
    const fill = new Uint8Array(ea.data.data);
    FS.writeFile(uniqueFileName, fill);
    if (lastSongFileName && vfsPathExists(lastSongFileName)) {
        FS.unlink(lastSongFileName);
        console.log(`JS Event: Cleaned up previous song file: ${lastSongFileName}`);
    }
    lastSongFileName = uniqueFileName;
    // Host safety-net (projectm-worklet-playback.js) reads this for retries.
    globalThis.projectMLastSongPath = uniqueFileName;
    setTimeout(function() {
        Module.ccall(
            'pl',                   // C function name
            null,                   // return type
            ['string'],             // argument types
            [uniqueFileName]        // arguments
        );
const shutDown=new BroadcastChannel('shutDown');
shutDown.postMessage({data:222});
    }, 250); // Shorter timeout should be fine
});

function getShader(pth,fname){
const ff=new XMLHttpRequest();
ff.open('GET',pth,true);
ff.responseType='arraybuffer';
var statEl5 = pmDoc.querySelector('#stat');
if (statEl5) { statEl5.innerHTML='Downloading Shader'; statEl5.style.backgroundColor='yellow'; }
ff.addEventListener("load",function(){
let sarrayBuffer=ff.response;
if(sarrayBuffer){
let sfil=new Uint8ClampedArray(sarrayBuffer);
FS.writeFile(fname,sfil);
console.log('got preset: '+fname);
pmDoc.querySelector('#stat').innerHTML='Downloaded Shader';
pmDoc.querySelector('#stat').style.backgroundColor='blue';
const presetFileNameToLoad = fname;
console.log("JS: Attempting to load pre-downloaded: " + presetFileNameToLoad);
try {
const content = FS.readFile(presetFileNameToLoad, { encoding: 'utf8' });
console.log("JS: Content of " + presetFileNameToLoad + " (first 200 chars):", content.substring(0,200));
if (content.length === 0) {
console.error("JS: File " + presetFileNameToLoad + " is EMPTY!");
}
} catch (e) {
console.error("JS: Failed to read file " + presetFileNameToLoad + " from FS:", e);
return;
}
}
});
ff.send(null);
}

function snd(){
    if ($sngs.length === 0) {
        console.log('No songs available yet.');
        return;
    }
    var pick = Math.floor(Math.random() * $sngs.length);
    let songSrc = $sngs[pick];
    console.log('Song: ', songSrc);
    var trackEl = pmDoc.querySelector('#track');
    if (trackEl) trackEl.src = songSrc;
    const sng = new BroadcastChannel('sng');
    sng.postMessage({data: songSrc});
}

var musicBtnEl = pmDoc.querySelector('#musicBtn');
if (musicBtnEl) {
    musicBtnEl.addEventListener('click',function(){
        openFlacDecoder();
        setTimeout(function(){
            snd();
        },1550);
    });
}

var milkBtnEl = pmDoc.querySelector('#milkBtn');
if (milkBtnEl) {
    milkBtnEl.addEventListener('click',function(){
        loadRandomCustomMilk();
    });
}

// #customMilkBtn is owned by the host page (randomCustom / preset picker).
// Do not attach a second click handler here — it caused double preset loads.

var createSpriteBtnEl = pmDoc.querySelector('#createSpriteBtn');
if (createSpriteBtnEl) {
    createSpriteBtnEl.addEventListener('click',function(){
        Module._createSprite();
    });
}

if (isCaptureMode) {
    console.log('projectM capture mode: skipping texture, song, and custom milk network scans.');
} else {
    scanTextures();
    scanSongs();
    if (isWeeksOnFire) {
        scanWeeksPresets(function(){
            seedWeeksPresetPlaylist(5);
            setTimeout(function(){ autoStartWeeksSong(); },2500);
        });
    } else {
        scanCustomMilk();
    }
}
var meshSizeEl = pmDoc.querySelector('#meshSize');
if (meshSizeEl) {
    meshSizeEl.addEventListener('change', (event) => {
        let meshValue = event.target.value;
        // Split the value into two numbers
        let values = meshValue.split(',').map(Number);
        console.log('Setting Mesh:', values[0], values[1]);
        Module._setMesh(values[0], values[1]);
    });
}


//  const meshValue = pmDoc.querySelector('#meshSize').value;
   // Split the value into two numbers
// const values = meshValue.split(',').map(Number);
// console.log('Setting Mesh:', values[0], values[1]);
// Module.setMesh(values[0], values[1]);


});
// clang-format on

// Reports an init() failure to the host page. If the page has defined
// globalThis.pmReportInitError(code, detail) (see html/projectm-init-errors.js), it is
// called so an overlay can be shown; otherwise the error is just logged.
//
// See docs/EMSCRIPTEN.md#init-error-codes for the meaning of `code`.
// clang-format off
EM_JS(void, js_report_init_error, (int code, const char* detail), {
    const detailStr = detail ? UTF8ToString(detail) : '';
    if (typeof globalThis.pmReportInitError === 'function') {
        globalThis.pmReportInitError(code, detailStr);
    } else {
        console.error('[projectM] init() failed with code ' + code + (detailStr ? ': ' + detailStr : ''));
    }
});
// clang-format on

// Notifies the host page that init() succeeded, so any previously shown init-error
// overlay can be hidden. See html/projectm-init-errors.js.
// clang-format off
EM_JS(void, js_report_init_success, (), {
    if (typeof globalThis.pmHideInitError === 'function') {
        globalThis.pmHideInitError();
    }
});
// clang-format on
