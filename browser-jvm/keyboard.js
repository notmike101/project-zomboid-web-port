// Real DOM state for the owned game canvas; native hooks query physical key codes.
export function keyboardNatives(canvas) {
 if (!(canvas instanceof HTMLCanvasElement) || !canvas.isConnected) throw new Error('Keyboard requires a connected canvas');
 const pressed = new Set();
 canvas.tabIndex = 0;
 const down = event => {if(document.activeElement===canvas){pressed.add(event.code);event.preventDefault();}};
 const up = event => pressed.delete(event.code);
 const clear = () => pressed.clear();
 window.addEventListener('keydown', down);window.addEventListener('keyup', up);
 window.addEventListener('blur', clear);canvas.addEventListener('blur', clear);
 document.addEventListener('visibilitychange', clear);
 const special = {32:'Space',39:'Quote',44:'Comma',45:'Minus',46:'Period',47:'Slash',59:'Semicolon',61:'Equal',91:'BracketLeft',92:'Backslash',93:'BracketRight',96:'Backquote',256:'Escape',257:'Enter',258:'Tab',259:'Backspace',260:'Insert',261:'Delete',262:'ArrowRight',263:'ArrowLeft',264:'ArrowDown',265:'ArrowUp',266:'PageUp',267:'PageDown',268:'Home',269:'End',280:'CapsLock',281:'ScrollLock',282:'NumLock',283:'PrintScreen',284:'Pause',330:'NumpadDecimal',331:'NumpadDivide',332:'NumpadMultiply',333:'NumpadSubtract',334:'NumpadAdd',335:'NumpadEnter',336:'NumpadEqual',340:'ShiftLeft',341:'ControlLeft',342:'AltLeft',343:'MetaLeft',344:'ShiftRight',345:'ControlRight',346:'AltRight',347:'MetaRight',348:'ContextMenu'};
 return {
  natives: {
   async Java_port_host_BrowserKeyboard_created(){return canvas.isConnected;},
   async Java_port_host_BrowserKeyboard_key(lib,key){
    if(!canvas.isConnected)throw new Error('Keyboard canvas was removed');
    let code=key>=65&&key<=90?'Key'+String.fromCharCode(key):key>=48&&key<=57?'Digit'+String.fromCharCode(key):key>=290&&key<=314?'F'+(key-289):key>=320&&key<=329?'Numpad'+(key-320):special[key];
    // shortcut: WORLD keys have no portable physical DOM code; reject ambiguous international input.
    if((key===161||key===162)&&[...pressed].some(value=>!value||value==='Unidentified'||value.startsWith('Intl')))throw new Error('International WORLD key mapping unavailable');
    return code&&pressed.has(code)?1:0;
   }
  },
  dispose(){clear();window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',clear);canvas.removeEventListener('blur',clear);document.removeEventListener('visibilitychange',clear);}
 };
}
