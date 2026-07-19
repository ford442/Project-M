"use strict"
function forceDownload(blob, filename){
}
function getDownloadLink(blob, filename, omitLinkLabel){
var name = filename || 'output.flac';
var url = (window.URL || window.webkitURL).createObjectURL(blob);
var link = window.document.createElement('a');
link.href = url;
link.download = name;
if(!omitLinkLabel){
link.textContent = name;
}
return link;
}
