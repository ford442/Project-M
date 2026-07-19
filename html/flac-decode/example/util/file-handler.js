"use strict";
function setEnabled(enable){
document.getElementById('files').disabled= !enable;
var color=enable?'':'lightgray';
var dropZone=document.getElementById('drop_zone');
dropZone.style.backgroundColor=color;
dropZone.style.color=color;
dropZone.style.borderColor=color;
var labelCl=enable?'init-hint':'drop-hint';
var labels=document.getElementsByClassName(labelCl);
var label;
for(var i=labels.length-1; i>=0; --i){
label=labels[i];
if(enable){
label.parentElement.removeChild(label);
}else{
var el=document.createElement('div');
el.classList.add('init-hint');
el.textContent='Initializing libflac.js ...';
el.style.color='black';
label.appendChild(el);
}
}
}
/**
 * initialize event handlers (GUI) for HTML elements
 *
 * @param onFileLoaded {Function} handler for (binary) file data, i.e. encoding/decoding file contents
 */
function initHandlers(onFileLoaded){
var isFlacInitialized=Flac.isReady();
if(!isFlacInitialized){
setEnabled(false);
Flac.on('ready',function(){
setEnabled(true);
});
}
var fileListHandler=createFileListHandler(onFileLoaded);
document.getElementById('files').addEventListener('change',fileListHandler,false);
var btnEl=document.getElementById('files_button');
if(btnEl){
btnEl.addEventListener('click',handle_process_button_click,false);
}
var dropZone=document.getElementById('drop_zone');
dropZone.addEventListener('dragover',handleDragOver,false);
dropZone.addEventListener('drop',fileListHandler,false);
function createFileListHandler(onFileLoaded){
return function handleFileSelect(evt){
evt.stopPropagation();
evt.preventDefault();
if(document.getElementById('files').disabled){
return;
}
var files;
if(evt.dataTransfer){
files=evt.dataTransfer.files;
}else{
files=evt.target.files;
}
document.getElementById('list').innerHTML='<ul id="file_list_info"></ul>';
var fileListInfoEl=document.getElementById('file_list_info');
var appendInfo=function(target){
var sb=[];
for(var i=1,size=arguments.length; i<size; ++i){
sb.push(arguments[i]);
}
var html=target.innerHTML.replace(/<\/ul>\s*$/igm,'');
target.innerHTML=html+sb.join('')+'</ul>';
};
for(var i=0,f; f=files[i]; i++){
var fileInfoId='file_info_'+i;
appendInfo(fileListInfoEl,'<li>','<strong>',(f.name || '').replace(/(<|>)/g,'_'),'</strong> (',f.type || 'n/a',') - ',f.size,' bytes, last modified: ',f.lastModifiedDate?f.lastModifiedDate.toLocaleDateString():'n/a','<span id="',fileInfoId,'"></span></li>');
var reader=new FileReader();
reader.file_name=f.name;
reader.file_info_id=fileInfoId;
reader.onload=function(evt){
evt.fileInfoId=this.file_info_id;
evt.fileName=this.file_name;
onFileLoaded.apply(this,arguments);
};
reader.readAsArrayBuffer(f);
}
};
}
function handleDragOver(evt){
evt.stopPropagation();
evt.preventDefault();
evt.dataTransfer.dropEffect='copy';
}
function handle_process_button_click(_evt){
var event;
if(document.createEvent){
event=document.createEvent("HTMLEvents");
event.initEvent("change",true,true);
}else{
event=document.createEventObject();
event.eventType="change";
}
event.eventName="change";
if(document.createEvent){
document.getElementById('files').dispatchEvent(event);
}else{
document.getElementById('files').fireEvent("on"+event.eventType,event);
}
}
}
function isDownload(){
return document.getElementById('check_download').checked;
}
function isVerify(){
return document.getElementById('check_verify').checked;
}
function isUseOgg(){
return document.getElementById('check_ogg').checked;
}
function getFileName(srcName,targetExt){
var flacExts=['flac','ogg','oga'];
var isCompressed=new RegExp(flacExts.join('|'),'i').test(targetExt);
var containerExt=/ogg/i.test(targetExt)?'ogg':'flac';
var source=isCompressed?'wav':'('+containerExt+'|'+flacExts.join('|')+')';
var target=isCompressed?containerExt:'wav';
var reSrc=new RegExp('\.'+source+'$','i');
var reTarget=new RegExp('\.'+target+'$','i');
var targetExtStr=/^\(?(\w+)/.exec(target)[1];
var fileName=srcName.replace(reSrc,'.'+targetExtStr);
if(!reTarget.test(fileName)){
fileName+='.'+target;
}
return fileName;
}
