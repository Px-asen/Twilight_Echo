import assert from 'node:assert/strict'
import test from 'node:test'
import { recognizePlaylistLink, isNeteaseShortLink, providerMatchesImportPlatform, reconcileImportEntries, previewImportUpdate } from './externalPlaylist.ts'
import { chooseStrictImportCandidate,strictImportCandidate } from './playlistImportMatching.ts'

test('recognizes domestic and international playlist links with strict host boundaries',()=>{
  for(const [url,platform,id] of [
    ['https://music.163.com/#/playlist?id=12','ncm','12'],['https://y.qq.com/n/ryqq/playlist/123','qq','123'],['https://i2.y.qq.com/n3/other/pages/details/playlist.html?id=9795590184','qq','9795590184'],['https\\://i2.y.qq.com/n3/other/pages/details/playlist.html?id=9795590184','qq','9795590184'],['https://www.kugou.com/yy/special/single/123.html?specialid=123','kugou','123'],['https://m.kugou.com/songlist/gcid_3z9eel5ez1oz0d8/?src_cid=3z9eel5ez1oz0d8','kugou','gcid_3z9eel5ez1oz0d8'],['https://www.kuwo.cn/playlist_detail/123','kuwo','123'],['https://music.douyin.com/playlist/123','qishui','123'],['https://space.bilibili.com/1/favlist?fid=123','bili','123'],['https://music.youtube.com/playlist?list=PL123','ytm','PL123'],['https://open.spotify.com/playlist/abc','spotify','abc'],['https://music.apple.com/cn/playlist/name/pl.abc','apple','pl.abc'],['https://tidal.com/browse/playlist/a-b','tidal','a-b'],['https://www.deezer.com/en/playlist/123','deezer','123']
  ]){const link=recognizePlaylistLink(url);assert.equal(link.platform,platform);assert.equal(link.id,id)}
  assert.equal(isNeteaseShortLink('https://163cn.tv/bi1XSgjy'),true)
  assert.equal(isNeteaseShortLink('https\\://163cn.tv/bi1XSgjy'),true)
  assert.equal(isNeteaseShortLink('https://evil163cn.tv/bi1XSgjy'),false)
  assert.equal(providerMatchesImportPlatform('com.twilightecho.provider.kugou','kugou'),true)
  assert.equal(providerMatchesImportPlatform('com.twilightecho.provider.qqmusic','qq'),true)
  assert.throws(()=>recognizePlaylistLink('https://open.spotify.com.evil.com/playlist/id'),/ID/)
  assert.throws(()=>recognizePlaylistLink('https://music.163.com/song?id=12'),/ID/)
})
const song={title:'Song',artist:'Artist',album:'Album',duration:180}
const candidate={...song,id:'local-1',source:'local'}
test('strict matching keeps 3-second boundary and recording versions separate',()=>{
  assert.equal(strictImportCandidate(song,{...candidate,duration:183}),true)
  assert.equal(strictImportCandidate(song,{...candidate,duration:183.001}),false)
  for(const patch of [{artist:'Other'},{title:'Song (Live)'},{album:'Album Remastered'},{title:'Song (Instrumental)'}])assert.equal(strictImportCandidate(song,{...candidate,...patch}),false)
  assert.equal(strictImportCandidate({title:'Song',artist:'Artist'},candidate),false)
  assert.equal(strictImportCandidate({...song,duration:undefined},candidate),true)
  assert.equal(chooseStrictImportCandidate(song,[candidate,{...candidate,id:'2'}]).ambiguous,true)
  assert.equal(strictImportCandidate({platform:'ncm',platformId:'42'},{...candidate,id:'ncm:42',source:'ncm'}),true)
  assert.equal(strictImportCandidate({isrc:'CN-123'},{...candidate,isrc:'CN123'}),true)
})
test('refresh reconciles occurrences FIFO and preserves manual bindings',()=>{
  let id=0;const first=reconcileImportEntries([], [song,song,{title:'Removed'}],()=>String(++id))
  first[1].manualBinding={...candidate,filePath:'a',fileName:'a',size:1,cover:null,lyrics:null}
  const next=reconcileImportEntries(first,[song,{title:'New'},song],()=>String(++id))
  assert.deepEqual(next.map(e=>e.entryId),['1','4','2']);assert.ok(next[2].manualBinding)
  assert.deepEqual(previewImportUpdate(first,[song,{title:'New'},song]),{added:1,removed:1,reordered:false})
})

test('refresh preview compares retained occurrences without counting insertions or removals as moves',()=>{
  let id=0
  const other={title:'Other',artist:'Artist'}
  const before=reconcileImportEntries([], [song,other,song,{title:'Removed'}],()=>String(++id))
  assert.deepEqual(previewImportUpdate(before,[{title:'Added'},song,other,song]),{added:1,removed:1,reordered:false})
  assert.deepEqual(previewImportUpdate(before,[other,song,song]),{added:0,removed:1,reordered:true})
  assert.deepEqual(previewImportUpdate(before,[song,song]),{added:0,removed:2,reordered:false})
  assert.deepEqual(previewImportUpdate(before,[]),{added:0,removed:4,reordered:false})
  assert.deepEqual(previewImportUpdate([],[song,song]),{added:2,removed:0,reordered:false})
  const next=reconcileImportEntries(before,[song,song,other],()=>String(++id))
  assert.deepEqual(next.map(entry=>entry.entryId),[before[0].entryId,before[2].entryId,before[1].entryId])
})

test('unchanged large previews inspect occurrence identities a bounded number of times',()=>{
  const songs=Array.from({length:2000},(_,index)=>({...song,title:`Song ${index}`}))
  let serial=0,identityReads=0
  const before=reconcileImportEntries([],songs,()=>String(++serial))
  for(const entry of before){
    const entryId=entry.entryId
    Object.defineProperty(entry,'entryId',{enumerable:true,get(){identityReads++;return entryId}})
  }
  assert.deepEqual(previewImportUpdate(before,songs),{added:0,removed:0,reordered:false})
  assert.ok(identityReads<before.length*10,`preview inspected ${identityReads} identities for ${before.length} entries`)
})
