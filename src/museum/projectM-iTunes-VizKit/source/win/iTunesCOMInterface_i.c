

/* this ALWAYS GENERATED file contains the IIDs and CLSIDs */

/* link this file in with the server and any clients */

/* File created by MIDL compiler version 6.00.0366 */
/* at Wed Jun 25 17:02:20 2008
 */
/* Compiler settings for iTunesCOMInterface.idl:
		Oicf, W1, Zp8, env=Win32 (32b run)
		protocol : dce , ms_ext, c_ext, robust
		error checks: allocation ref bounds_check enum stub_data
		VC __declspec() decoration level:
				 __declspec(uuid()), __declspec(selectany), __declspec(novtable)
				 DECLSPEC_UUID(), MIDL_INTERFACE()
*/
//@@MIDL_FILE_HEADING(  )

#pragma warning(disable : 4049) /* more than 64k source lines */

#ifdef __cplusplus
extern "C"
{
#endif

#include <rpc.h>
#include <rpcndr.h>

#ifdef _MIDL_USE_GUIDDEF_

#ifndef INITGUID
#define INITGUID
#include <guiddef.h>
#undef INITGUID
#else
#include <guiddef.h>
#endif

#define MIDL_DEFINE_GUID(type, name, l, w1, w2, b1, b2, b3, b4, b5, b6, b7, b8) \
	DEFINE_GUID(name, l, w1, w2, b1, b2, b3, b4, b5, b6, b7, b8)

#else // !_MIDL_USE_GUIDDEF_

#ifndef __IID_DEFINED__
#define __IID_DEFINED__

typedef struct _IID
{
	unsigned long x;
	unsigned short s1;
	unsigned short s2;
	unsigned char c[8];
} IID;

#endif // __IID_DEFINED__

#ifndef CLSID_DEFINED
#define CLSID_DEFINED
typedef IID CLSID;
#endif // CLSID_DEFINED

#define MIDL_DEFINE_GUID(type, name, l, w1, w2, b1, b2, b3, b4, b5, b6, b7, b8) \
	const type name = {l, w1, w2, {b1, b2, b3, b4, b5, b6, b7, b8}}

#endif !_MIDL_USE_GUIDDEF_

	MIDL_DEFINE_GUID(IID, LIBID_iTunesLib, 0x9E93C96F, 0xCF0D, 0x43f6, 0x8B, 0xA8, 0xB8, 0x07, 0xA3,
		0x37, 0x07, 0x12);

	MIDL_DEFINE_GUID(
		IID, IID_IITObject, 0x9FAB0E27, 0x70D7, 0x4e3a, 0x99, 0x65, 0xB0, 0xC8, 0xB8, 0x86, 0x9B, 0xB6);

	MIDL_DEFINE_GUID(
		IID, IID_IITSource, 0xAEC1C4D3, 0xAEF1, 0x4255, 0xB8, 0x92, 0x3E, 0x3D, 0x13, 0xAD, 0xFD, 0xF9);

	MIDL_DEFINE_GUID(IID, IID_IITSourceCollection, 0x2FF6CE20, 0xFF87, 0x4183, 0xB0, 0xB3, 0xF3, 0x23,
		0xD0, 0x47, 0xAF, 0x41);

	MIDL_DEFINE_GUID(IID, IID_IITEncoder, 0x1CF95A1C, 0x55FE, 0x4f45, 0xA2, 0xD3, 0x85, 0xAC, 0x6C,
		0x50, 0x4A, 0x73);

	MIDL_DEFINE_GUID(IID, IID_IITEncoderCollection, 0x8862BCA9, 0x168D, 0x4549, 0xA9, 0xD5, 0xAD,
		0xB3, 0x5E, 0x55, 0x3B, 0xA6);

	MIDL_DEFINE_GUID(IID, IID_IITEQPreset, 0x5BE75F4F, 0x68FA, 0x4212, 0xAC, 0xB7, 0xBE, 0x44, 0xEA,
		0x56, 0x97, 0x59);

	MIDL_DEFINE_GUID(IID, IID_IITEQPresetCollection, 0xAEF4D111, 0x3331, 0x48da, 0xB0, 0xC2, 0xB4,
		0x68, 0xD5, 0xD6, 0x1D, 0x08);

	MIDL_DEFINE_GUID(IID, IID_IITPlaylist, 0x3D5E072F, 0x2A77, 0x4b17, 0x9E, 0x73, 0xE0, 0x3B, 0x77,
		0xCC, 0xCC, 0xA9);

	MIDL_DEFINE_GUID(IID, IID_IITOperationStatus, 0x206479C9, 0xFE32, 0x4f9b, 0xA1, 0x8A, 0x47, 0x5A,
		0xC9, 0x39, 0xB4, 0x79);

	MIDL_DEFINE_GUID(IID, IID_IITConvertOperationStatus, 0x7063AAF6, 0xABA0, 0x493b, 0xB4, 0xFC, 0x92,
		0x0A, 0x9F, 0x10, 0x58, 0x75);

	MIDL_DEFINE_GUID(IID, IID_IITLibraryPlaylist, 0x53AE1704, 0x491C, 0x4289, 0x94, 0xA0, 0x95, 0x88,
		0x15, 0x67, 0x5A, 0x3D);

	MIDL_DEFINE_GUID(IID, IID_IITUserPlaylist, 0x0A504DED, 0xA0B5, 0x465a, 0x8A, 0x94, 0x50, 0xE2,
		0x0D, 0x7D, 0xF6, 0x92);

	MIDL_DEFINE_GUID(
		IID, IID_IITTrack, 0x4CB0915D, 0x1E54, 0x4727, 0xBA, 0xF3, 0xCE, 0x6C, 0xC9, 0xA2, 0x25, 0xA1);

	MIDL_DEFINE_GUID(IID, IID_IITTrackCollection, 0x755D76F1, 0x6B85, 0x4ce4, 0x8F, 0x5F, 0xF8, 0x8D,
		0x97, 0x43, 0xDC, 0xD8);

	MIDL_DEFINE_GUID(
		IID, IID_IITVisual, 0x340F3315, 0xED72, 0x4c09, 0x9A, 0xCF, 0x21, 0xEB, 0x4B, 0xDF, 0x99, 0x31);

	MIDL_DEFINE_GUID(IID, IID_IITVisualCollection, 0x88A4CCDD, 0x114F, 0x4043, 0xB6, 0x9B, 0x84, 0xD4,
		0xE6, 0x27, 0x49, 0x57);

	MIDL_DEFINE_GUID(
		IID, IID_IITWindow, 0x370D7BE0, 0x3A89, 0x4a42, 0xB9, 0x02, 0xC7, 0x5F, 0xC1, 0x38, 0xBE, 0x09);

	MIDL_DEFINE_GUID(IID, IID_IITBrowserWindow, 0xC999F455, 0xC4D5, 0x4aa4, 0x82, 0x77, 0xF9, 0x97,
		0x53, 0x69, 0x99, 0x74);

	MIDL_DEFINE_GUID(IID, IID_IITWindowCollection, 0x3D8DE381, 0x6C0E, 0x481f, 0xA8, 0x65, 0xE2, 0x38,
		0x5F, 0x59, 0xFA, 0x43);

	MIDL_DEFINE_GUID(
		IID, IID_IiTunes, 0x9DD6680B, 0x3EDC, 0x40db, 0xA7, 0x71, 0xE6, 0xFE, 0x48, 0x32, 0xE3, 0x4A);

	MIDL_DEFINE_GUID(IID, DIID__IiTunesEvents, 0x5846EB78, 0x317E, 0x4b6f, 0xB0, 0xC3, 0x11, 0xEE,
		0x8C, 0x8F, 0xEE, 0xF2);

	MIDL_DEFINE_GUID(IID, DIID__IITConvertOperationStatusEvents, 0x5C47A705, 0x8E8A, 0x45a1, 0x9E,
		0xED, 0x71, 0xC9, 0x93, 0xF0, 0xBF, 0x60);

	MIDL_DEFINE_GUID(CLSID, CLSID_iTunesApp, 0xDC0C2640, 0x1415, 0x4644, 0x87, 0x5C, 0x6F, 0x4D, 0x76,
		0x98, 0x39, 0xBA);

	MIDL_DEFINE_GUID(CLSID, CLSID_iTunesConvertOperationStatus, 0xD06596AD, 0xC900, 0x41b2, 0xBC,
		0x68, 0x1B, 0x48, 0x64, 0x50, 0xFC, 0x56);

	MIDL_DEFINE_GUID(IID, IID_IITArtwork, 0xD0A6C1F8, 0xBF3D, 0x4cd8, 0xAC, 0x47, 0xFE, 0x32, 0xBD,
		0xD1, 0x72, 0x57);

	MIDL_DEFINE_GUID(IID, IID_IITArtworkCollection, 0xBF2742D7, 0x418C, 0x4858, 0x9A, 0xF9, 0x29,
		0x81, 0xB0, 0x62, 0xD2, 0x3E);

	MIDL_DEFINE_GUID(IID, IID_IITURLTrack, 0x1116E3B5, 0x29FD, 0x4393, 0xA7, 0xBD, 0x45, 0x4E, 0x5E,
		0x32, 0x79, 0x00);

	MIDL_DEFINE_GUID(IID, IID_IITAudioCDPlaylist, 0xCF496DF3, 0x0FED, 0x4d7d, 0x9B, 0xD8, 0x52, 0x9B,
		0x6E, 0x8A, 0x08, 0x2E);

	MIDL_DEFINE_GUID(IID, IID_IITPlaylistCollection, 0xFF194254, 0x909D, 0x4437, 0x9C, 0x50, 0x3A,
		0xAC, 0x2A, 0xE6, 0x30, 0x5C);

	MIDL_DEFINE_GUID(IID, IID_IITIPodSource, 0xCF4D8ACE, 0x1720, 0x4fb9, 0xB0, 0xAE, 0x98, 0x77, 0x24,
		0x9E, 0x89, 0xB0);

	MIDL_DEFINE_GUID(IID, IID_IITFileOrCDTrack, 0x00D7FE99, 0x7868, 0x4cc7, 0xAD, 0x9E, 0xAC, 0xFD,
		0x70, 0xD0, 0x95, 0x66);

	MIDL_DEFINE_GUID(IID, IID_IITPlaylistWindow, 0x349CBB45, 0x2E5A, 0x4822, 0x8E, 0x4A, 0xA7, 0x55,
		0x55, 0xA1, 0x86, 0xF7);

#undef MIDL_DEFINE_GUID

#ifdef __cplusplus
}
#endif
