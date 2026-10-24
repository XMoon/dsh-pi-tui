import { ProcessTerminal } from '@xmoon76/pi-tui'
import { TuiApp } from './src/tui-app.ts'
import { ImageLoader } from './src/client/media/image/loader.ts'
const png = Uint8Array.from(Buffer.from(process.env.PROBE_PNG_B64 ?? '', 'base64'))
const mk = (id:string,name:string,w:number,h:number)=>({attachmentId:id,mediaType:'image/png' as const,bytes:png.byteLength,width:w,height:h,name})
const loader = new ImageLoader(async()=>({ref:{},data:png}))
const terminal = new ProcessTerminal()
const app: TuiApp = new TuiApp(terminal,{onSubmit:()=>{},onExit:()=>{app.stop();process.exit(0)}},
  {imageLoader:loader,imageTheme:{fallbackColor:(t:string)=>t}})
app.start()
app.setTranscript([
  {kind:'user',turn:0,text:'square',content:[{type:'text',text:'square'},{type:'image',attachment:mk('s','square.png',100,100)}]} as never,
  {kind:'user',turn:0,text:'wide',content:[{type:'text',text:'wide'},{type:'image',attachment:mk('w','wide.png',800,100)}]} as never,
] as never)
app.setFullscreen(true)
setTimeout(()=>{ if(process.env.PROBE==='list') (app as unknown as {openTranscriptImagePicker():void}).openTranscriptImagePicker() }, Number(process.env.PROBE_WAIT_MS??4000))
