/*
	Adding noise using canvas 
*/	  
function addBackgroundNoise(el, color, alpha) {    	
	var canvas = document.createElement('canvas');
	canvas.width = 50;
	canvas.height = 50;
	 
	var ctx = canvas.getContext('2d');

	ctx.fillStyle = color;
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	 
	var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
	var pixels = imageData.data, r, g, b, origR, origG, origB;
	var alpha1 = 1 - alpha
	 
	for (var i = 0, il = pixels.length; i < il; i += 4) {
		// генерируем пиксель «шума»
		var color = Math.random();
		 
		origR = pixels[i];
		origG = pixels[i + 1];
		origB = pixels[i + 2];
		 
		// высчитываем итоговый цвет в режиме multiply без альфа-композиции
		r = origR * color;
		g = origG * color;
		b = origB * color;
		 
		// альфа-композиция
		pixels[i] =     r * alpha + origR * alpha1;
		pixels[i + 1] = g * alpha + origG * alpha1;
		pixels[i + 2] = b * alpha + origB * alpha1;
	}
	 
	ctx.putImageData(imageData, 0, 0);

	el.style.backgroundImage = "url(" + canvas.toDataURL() + ")";
}

addBackgroundNoise(document.getElementsByTagName('aside')[0], "#eee", 0.02);
addBackgroundNoise(document.getElementsByTagName('html')[0], "#f7f7f7", 0.02);