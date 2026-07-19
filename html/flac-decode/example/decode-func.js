function decodeFlac(binData,decData,isVerify,isOgg,isAllMetadata){
var flac_decoder,VERIFY=true,flac_ok=1,analyse_frames=false,analyse_residuals=false,meta_data,streamInfo=null,all_meta_data=isAllMetadata?[]:null,enable_raw_metadata=isAllMetadata;
var currentDataOffset=0;
var size=binData.buffer.byteLength;
VERIFY=isVerify || false;
/** @memberOf decode */
function read_callback_fn(bufferSize){
var end=currentDataOffset === size?-1:Math.min(currentDataOffset+bufferSize,size);
var _buffer;
var numberOfReadBytes;
if(end !== -1){
_buffer=binData.subarray(currentDataOffset,end);
numberOfReadBytes=end-currentDataOffset;
currentDataOffset=end;
}else{
numberOfReadBytes=0;
}
return {buffer:_buffer,readDataLength:numberOfReadBytes,error:false};
}
/** @memberOf decode */
function write_callback_fn(buffer,frameHdr){
decData.push(buffer);
if(frameHdr && frameHdr.sampleRate && frameHdr.channels && frameHdr.bitsPerSample){
streamInfo={
sampleRate:frameHdr.sampleRate,
channels:frameHdr.channels,
bitsPerSample:frameHdr.bitsPerSample
};
}
}
/** @memberOf decode */
function metadata_callback_fn(data,dataBlock){
if(data){
meta_data=data;
}else{
console.info('  meta data block: ',dataBlock);
if(all_meta_data){
all_meta_data.push(dataBlock);
}
}
}
/** @memberOf decode */
function error_callback_fn(err,errMsg){
console.error('decode error callback',err,errMsg);
}
// if(flac_file_processing_check_flac_format(binData,isOgg) == false){ var container=isOgg?'OGG/':''; return {error:'Wrong '+container+'FLAC file format',status:1}; }
flac_decoder=Flac.create_libflac_decoder(VERIFY);
if(flac_decoder != 0){
if(isAllMetadata){
Flac.FLAC__stream_decoder_set_metadata_respond_all(flac_decoder);
}
var init_status=Flac.init_decoder_stream(flac_decoder,read_callback_fn,write_callback_fn,error_callback_fn,metadata_callback_fn,isOgg);
Flac.setOptions(flac_decoder,{analyseSubframes:analyse_frames,analyseResiduals:analyse_residuals,enableRawStreamMetadata:enable_raw_metadata});
flac_ok&=init_status == 0;
}else{
var msg='Error initializing the decoder.';
console.error(msg);
return {error:msg,status:1};
}
var isDecodePartial=true;
var flac_return=1;
if(!isDecodePartial){
flac_return&=Flac.FLAC__stream_decoder_process_until_end_of_stream(flac_decoder);
if(flac_return != true){
console.error('encountered error during decoding data');
}
}else{
var state=0;
while(state<=3 && flac_return != false){
flac_return&=Flac.FLAC__stream_decoder_process_single(flac_decoder);
state=Flac.FLAC__stream_decoder_get_state(flac_decoder);
}
flac_ok&=flac_return != false;
}
flac_ok&=Flac.FLAC__stream_decoder_finish(flac_decoder);
if(flac_ok != 1){
flac_ok=Flac.FLAC__stream_decoder_get_state(flac_decoder);
}
Flac.FLAC__stream_decoder_delete(flac_decoder);
if(all_meta_data){
meta_data.extractedMetadata=all_meta_data;
}
return {metaData:meta_data,streamInfo:streamInfo,status:flac_ok};
}
