// Student photo picker, shared by the login page and the portal.
// SSPhoto.fromFile(file) → Promise<data URL>: a square, centre-cropped 320 px JPEG (~15–40 KB).
(function () {
  var SIZE = 320;
  function fromFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file) return reject(new Error('Choose a photo.'));
      if (!/^image\//.test(file.type)) return reject(new Error('That file is not a photo. Use a JPG or PNG picture.'));
      if (file.size > 15 * 1048576) return reject(new Error('That photo is larger than 15 MB. Choose a smaller picture.'));
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var w = img.naturalWidth, h = img.naturalHeight, s = Math.min(w, h);
        if (s < 80) return reject(new Error('That photo is too small. Use a clearer picture of your face.'));
        var c = document.createElement('canvas');
        c.width = SIZE; c.height = SIZE;
        var g = c.getContext('2d');
        g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, SIZE, SIZE);
        g.drawImage(img, (w - s) / 2, (h - s) / 2, s, s, 0, 0, SIZE, SIZE);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read that photo. Try a JPG or PNG picture.')); };
      img.src = url;
    });
  }
  window.SSPhoto = { fromFile: fromFile };
})();
