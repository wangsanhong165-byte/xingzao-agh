import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {STLLoader} from 'three/addons/loaders/STLLoader.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
const file=new URLSearchParams(location.search).get('file'),canvas=document.getElementById('canvas'),status=document.getElementById('status');
async function show(){
 if(!/^(?:评审案例\/(?:character\/(?:color\.glb|source\.stl|print\.stl)|photo\/source\.stl)|测试样例\/case\/(?:source-original\.stl|normal-source\.stl|five\/posed\.stl))$/u.test(file??''))throw Error('请选择案例页中的随包模型');
 const scene=new THREE.Scene();scene.background=new THREE.Color('#10211e');
 const renderer=new THREE.WebGLRenderer({canvas,antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));
 const isGlb=file.endsWith('.glb'),camera=new THREE.PerspectiveCamera(35,1,.01,10000);camera.up.set(...(isGlb?[0,1,0]:[0,0,1]));
 const controls=new OrbitControls(camera,canvas);controls.enableDamping=true;
 scene.add(new THREE.HemisphereLight(0xffffff,0x729789,2));const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(60,-80,120);scene.add(light);
 const url='/review-files/'+encodeURI(file);let model;
 if(isGlb)model=(await new GLTFLoader().loadAsync(url)).scene;
 else model=new THREE.Mesh(await new STLLoader().loadAsync(url),new THREE.MeshStandardMaterial({color:0xb3d3cd,roughness:.65}));
 const box=new THREE.Box3().setFromObject(model),center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3()),s=Math.max(size.x,size.y,size.z);
 model.position.sub(center);scene.add(model);camera.near=s/1000;camera.far=s*100;
 if(isGlb)camera.position.set(s*.7,s*.45,s*2.2);else camera.position.set(s*1.5,-s*1.9,s*.9);
 controls.target.set(0,0,0);controls.update();
 function resize(){const w=canvas.clientWidth,h=canvas.clientHeight;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();}resize();window.addEventListener('resize',resize);
 status.textContent=file.split('/').at(-1)+' · '+size.toArray().map(n=>(n*(isGlb?1000:1)).toFixed(1)).join(' × ')+' mm';
 renderer.setAnimationLoop(()=>{controls.update();renderer.render(scene,camera);});
}
show().catch(e=>{status.textContent='模型预览未完成：'+e.message;});
