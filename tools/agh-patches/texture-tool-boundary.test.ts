import {describe,it,expect} from 'vitest'
import {discloseTools} from '../src/step/inference.js'
import {approveAndExecute} from '../src/step/tools.js'

const permitted=['texture_inspect','texture_generate','texture_verify','texture_submit']
function session(name='texture-tools'){
 const events:any[]=[]
 const defs=[...permitted,'shell','read','run_code'].map(name=>({name,meta:{deferLoading:false}}))
 const value={preset:{name,disclosure:'standard',compaction:{enabled:false,agentCallable:false}},compaction:{runnable:false},turn:{snapshot:{defs,byName:new Map()}},state:{toolCalls:new Map()},d:{runtime:{enforcement:()=>({})}},op:()=>({}),ev:(type:string,payload:any)=>({type,payload}),transition:async(rows:any[])=>{events.push(...rows)}}
 return {value:value as unknown as Parameters<typeof discloseTools>[0],events}
}
describe('texture task native boundary',()=>{
 it('discloses exactly the four texture tools',()=>{expect(discloseTools(session().value)).toEqual(permitted)})
 it('preserves the existing standard disclosure for other presets',()=>{expect(discloseTools(session('standard').value)).toContain('shell')})
 it('refuses an undisclosed shell call before registry lookup or dispatch',async()=>{
  const s=session()
  const call={name:'shell',toolUseId:'outside'} as Parameters<typeof approveAndExecute>[1]
  const result=await approveAndExecute(s.value,call,{} as Parameters<typeof approveAndExecute>[2])
  expect(result.result?.isError).toBe(true)
  expect(s.events).toContainEqual(expect.objectContaining({type:'tool/result',payload:expect.objectContaining({code:'TOOL_NOT_ALLOWED_BY_PRESET'})}))
 })
})
