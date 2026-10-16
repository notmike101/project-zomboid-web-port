/** Real selected WebGL2 native facade. No desktop native pointers or libraries. */
export function createSpriteNatives(canvas, report) {
  const gl=canvas.getContext('webgl2',{alpha:true,antialias:false,premultipliedAlpha:false,preserveDrawingBuffer:true});
  if(!gl)throw Error('WebGL2 unavailable');
  let next=1,activeUnit=gl.TEXTURE0;
  const shaders=new Map(),programs=new Map(),textures=new Map(),buffers=new Map(),framebuffers=new Map(),locations=new Map();
  const shaderTypes=new Map(),sourceDefaults=new Map(),attached=new Map(),locationOwners=new Map(),legacyTexture=new Map();
  const diagnostics=[];
  const note=text=>{diagnostics.push(text);if(diagnostics.length>64)diagnostics.shift();};
  const object=(map,id)=>{if(id===0)return null;const value=map.get(id);if(!value)throw Error('Unknown graphics handle '+id);return value;};
  const add=(map,value)=>{if(value===null)return 0;const id=next++;map.set(id,value);return id;};
  const bytes=value=>value===null?null:new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
  const floats=value=>new Float32Array(value.buffer,value.byteOffset,value.byteLength/4);
  const location=id=>id===-1?null:object(locations,id);
  const ensure=()=>{if(gl.isContextLost())throw Error('WebGL context lost');};
  function translate(id,source){
    const defaults=[];sourceDefaults.set(id,defaults);
    const version=/^\s*#version\s+(330(?:\s+core)?|120)\s*$/m.exec(source);
    if(!version)return source;
    const legacy=version[1]==='120';
    source=source.slice(0,version.index)+'#version 300 es\nprecision highp float;\nprecision highp int;\n'+source.slice(version.index+version[0].length);
    source=source.replace(/^(\s*uniform\s+(float|int)\s+([A-Za-z_]\w*)\s*)=\s*([^;]+);/gm,(all,declaration,type,name,text)=>{
      const literal=text.trim(),integer=type==='int';
      const pattern=integer?/^[+-]?\d+$/:/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
      if(!pattern.test(literal))throw Error('Unsupported GLSL uniform initializer '+literal);
      let value=Number(literal);if(integer){if(!Number.isInteger(value)||value< -2147483648||value>2147483647)throw Error('Integer uniform initializer out of range');}else value=Math.fround(value);
      if(!Number.isFinite(value))throw Error('Non-finite uniform initializer');
      defaults.push({name,integer,value});return declaration+';';
    });
    source=source.replace(/\btexture2D\b/g,'texture');
    if(legacy){
      if(shaderTypes.get(id)===gl.VERTEX_SHADER)source=source.replace(/^(\s*)attribute\b/gm,'$1in').replace(/^(\s*)varying\b/gm,'$1out');
      else if(shaderTypes.get(id)===gl.FRAGMENT_SHADER)source=source.replace(/^(\s*)varying\b/gm,'$1in');
      else throw Error('Unsupported legacy shader stage');
    }
    if(/\bgl_FragColor\b/.test(source)){
      if(shaderTypes.get(id)!==gl.FRAGMENT_SHADER)throw Error('Fragment output in non-fragment shader');
      source=source.replace(/\bgl_FragColor\b/g,'portFragmentOutput');
      const line=source.indexOf('\n');source=source.slice(0,line+1)+'layout(location=0) out highp vec4 portFragmentOutput;\n'+source.slice(line+1);
    }
    return source;
  }
  const api={
    initialize:ensure,contextCreated:()=>!gl.isContextLost(),resize:(w,h)=>{canvas.width=w;canvas.height=h;},surfaceWidth:()=>gl.drawingBufferWidth,surfaceHeight:()=>gl.drawingBufferHeight,
    present:async vsync=>{ensure();gl.flush();if(vsync)await new Promise(requestAnimationFrame);},report,
    bufferCreate:()=>add(buffers,gl.createBuffer()),bufferBind:(target,id)=>gl.bindBuffer(target,object(buffers,id)),
    bufferDelete:id=>{gl.deleteBuffer(object(buffers,id));buffers.delete(id);},bufferIs:id=>gl.isBuffer(object(buffers,id)),
    bufferDataSize:(target,size,usage)=>gl.bufferData(target,size,usage),bufferDataBytes:(target,data,usage)=>gl.bufferData(target,bytes(data),usage),
    bufferUpload:(target,offset,data)=>gl.bufferSubData(target,offset,bytes(data)),bufferRead:(target,offset,data)=>gl.getBufferSubData(target,offset,bytes(data)),
    bufferParameter:(target,name)=>{const value=gl.getBufferParameter(target,name);if(typeof value!=='number')throw Error('Unsupported buffer parameter');return value;},
    rawError:()=>gl.getError(),integerState:name=>{const value=gl.getParameter(name);if(typeof value==='number')return value;if(typeof value==='boolean')return Number(value);if(value===null)return 0;for(const map of[programs,textures,buffers,framebuffers])for(const[id,item]of map)if(item===value)return id;throw Error('Unsupported scalar graphics query '+name);},
    vertexPointer:(index,size,type,normalized,stride,offset)=>gl.vertexAttribPointer(index,size,type,normalized,stride,offset),
    drawRange:(mode,first,last,count,type,offset)=>gl.drawRangeElements(mode,first,last,count,type,offset),
    glEnableVertexAttribArray:index=>gl.enableVertexAttribArray(index),glDisableVertexAttribArray:index=>gl.disableVertexAttribArray(index),
    glActiveTexture:unit=>{gl.activeTexture(unit);if(unit>=gl.TEXTURE0&&unit<gl.TEXTURE0+gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS))activeUnit=unit;},
    glEnable:cap=>{if(cap===gl.TEXTURE_2D)legacyTexture.set(activeUnit,true);else gl.enable(cap);},
    glDisable:cap=>{if(cap===gl.TEXTURE_2D)legacyTexture.set(activeUnit,false);else gl.disable(cap);},
    glIsEnabled:cap=>cap===gl.TEXTURE_2D?legacyTexture.get(activeUnit)===true:gl.isEnabled(cap),
    glBlendFunc:(s,d)=>gl.blendFunc(s,d),glBlendFuncSeparate:(a,b,c,d)=>gl.blendFuncSeparate(a,b,c,d),glBlendEquation:mode=>gl.blendEquation(mode),
    glViewport:(x,y,w,h)=>gl.viewport(x,y,w,h),glClearColor:(r,g,b,a)=>gl.clearColor(r,g,b,a),glClear:mask=>gl.clear(mask),glDrawArrays:(mode,first,count)=>gl.drawArrays(mode,first,count),
    glCreateShader:type=>{const id=add(shaders,gl.createShader(type));shaderTypes.set(id,type);return id;},
    shaderText:(id,text)=>gl.shaderSource(object(shaders,id),translate(id,String(text))),
    glCompileShader:id=>{gl.compileShader(object(shaders,id));note('compile '+id+' '+gl.getShaderParameter(object(shaders,id),gl.COMPILE_STATUS)+' '+gl.getShaderInfoLog(object(shaders,id)));},
    glGetShaderi:(id,name)=>name===0x8B84?(gl.getShaderInfoLog(object(shaders,id))||'').length+1:Number(gl.getShaderParameter(object(shaders,id),name)),
    glGetShaderInfoLog:(id,length)=>(gl.getShaderInfoLog(object(shaders,id))||'').slice(0,Math.max(0,length-1)),
    glDeleteShader:id=>{gl.deleteShader(object(shaders,id));},
    glCreateProgram:()=>add(programs,gl.createProgram()),glAttachShader:(program,shader)=>{gl.attachShader(object(programs,program),object(shaders,shader));if(!attached.has(program))attached.set(program,[]);attached.get(program).push(shader);},
    glDetachShader:(program,shader)=>{gl.detachShader(object(programs,program),object(shaders,shader));attached.set(program,(attached.get(program)||[]).filter(id=>id!==shader));},
    bindAttribute:(program,index,name)=>gl.bindAttribLocation(object(programs,program),index,String(name)),attributeLocation:(program,name)=>gl.getAttribLocation(object(programs,program),String(name)),
    glLinkProgram:id=>{const program=object(programs,id);gl.linkProgram(program);note('link '+id+' '+gl.getProgramParameter(program,gl.LINK_STATUS)+' '+gl.getProgramInfoLog(program));if(!gl.getProgramParameter(program,gl.LINK_STATUS))return;const previous=gl.getParameter(gl.CURRENT_PROGRAM);gl.useProgram(program);try{for(const shader of attached.get(id)||[])for(const init of sourceDefaults.get(shader)||[]){const where=gl.getUniformLocation(program,init.name);if(where!==null){if(init.integer)gl.uniform1i(where,init.value);else gl.uniform1f(where,init.value);}}}finally{gl.useProgram(previous);}},
    glValidateProgram:id=>{gl.validateProgram(object(programs,id));note('validate '+id+' '+gl.getProgramParameter(object(programs,id),gl.VALIDATE_STATUS)+' '+gl.getProgramInfoLog(object(programs,id)));},
    glGetProgrami:(id,name)=>name===0x8B84?(gl.getProgramInfoLog(object(programs,id))||'').length+1:Number(gl.getProgramParameter(object(programs,id),name)),
    glGetProgramInfoLog:(id,length)=>(gl.getProgramInfoLog(object(programs,id))||'').slice(0,Math.max(0,length-1)),glUseProgram:id=>gl.useProgram(object(programs,id)),
    glDeleteProgram:id=>{gl.deleteProgram(object(programs,id));programs.delete(id);attached.delete(id);for(const[location,owner]of locationOwners)if(owner===id){locationOwners.delete(location);locations.delete(location);}},
    uniformLocation:(program,name)=>{const value=gl.getUniformLocation(object(programs,program),String(name));if(value===null)return -1;const id=add(locations,value);locationOwners.set(id,program);return id;},
    activeUniformName:(program,index)=>{const value=gl.getActiveUniform(object(programs,program),index);if(!value)throw Error('Invalid uniform index');return value.name;},
    activeUniformProperty:(program,index,type)=>{const value=gl.getActiveUniform(object(programs,program),index);if(!value)throw Error('Invalid uniform index');return type?value.type:value.size;},
    glUniform1i:(id,x)=>gl.uniform1i(location(id),x),glUniform1f:(id,x)=>gl.uniform1f(location(id),x),glUniform2f:(id,x,y)=>gl.uniform2f(location(id),x,y),glUniform3f:(id,x,y,z)=>gl.uniform3f(location(id),x,y,z),glUniform4f:(id,x,y,z,w)=>gl.uniform4f(location(id),x,y,z,w),
    matrix4:(id,data)=>gl.uniformMatrix4fv(location(id),false,floats(data)),matrix3:(id,data)=>gl.uniformMatrix3fv(location(id),false,floats(data)),
    glGenTextures:()=>add(textures,gl.createTexture()),glBindTexture:(target,id)=>gl.bindTexture(target,object(textures,id)),glDeleteTextures:id=>{gl.deleteTexture(object(textures,id));textures.delete(id);},glTexParameteri:(target,name,value)=>gl.texParameteri(target,name,value),
    textureBytes:(target,level,internal,w,h,border,format,type,data)=>{if(format!==gl.RGBA||type!==gl.UNSIGNED_BYTE||![gl.RGBA,gl.RGBA8].includes(internal))throw Error('Unsupported texture format');gl.texImage2D(target,level,internal,w,h,border,format,type,bytes(data));},
    readPixels:(x,y,w,h,format,type,data)=>gl.readPixels(x,y,w,h,format,type,bytes(data)),
    glGenFramebuffers:()=>add(framebuffers,gl.createFramebuffer()),glBindFramebuffer:(target,id)=>gl.bindFramebuffer(target,object(framebuffers,id)),glDeleteFramebuffers:id=>{gl.deleteFramebuffer(object(framebuffers,id));framebuffers.delete(id);},glCheckFramebufferStatus:target=>gl.checkFramebufferStatus(target),glFramebufferTexture2D:(target,attachment,textureTarget,id,level)=>gl.framebufferTexture2D(target,attachment,textureTarget,object(textures,id),level),
  };
  const natives={};for(const[name,callback]of Object.entries(api))natives['Java_port_host_SpriteGraphics_'+name]=async(lib,...args)=>callback(...args);
  return {natives,diagnostics,resources:()=>({shaders:shaders.size,programs:programs.size,textures:textures.size,buffers:buffers.size,framebuffers:framebuffers.size})};
}
