// 从 icon.ico 里导出指定尺寸的 PNG，供 go-winres 使用。
package main

import (
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
)

func main() {
	data, err := os.ReadFile("../desktop/icon.ico")
	if err != nil { fmt.Println(err); os.Exit(1) }
	count := int(binary.LittleEndian.Uint16(data[4:6]))
	for i := 0; i < count; i++ {
		b := data[6+i*16:]
		w := int(b[0])
		if w == 0 { w = 256 }
		length := int(binary.LittleEndian.Uint32(b[8:12]))
		offset := int(binary.LittleEndian.Uint32(b[12:16]))
		frame := data[offset : offset+length]
		img, err := decodeDIB(frame, w)
		if err != nil { fmt.Println(w, err); continue }
		out := fmt.Sprintf("../desktop/winres/icon-%d.png", w)
		f, _ := os.Create(out)
		png.Encode(f, img)
		f.Close()
		fmt.Println("wrote", out)
	}
}

func decodeDIB(frame []byte, s int) (image.Image, error) {
	if len(frame) < 40 { return nil, fmt.Errorf("too short") }
	hdrSize := int(binary.LittleEndian.Uint32(frame[0:4]))
	width := int(int32(binary.LittleEndian.Uint32(frame[4:8])))
	height := int(int32(binary.LittleEndian.Uint32(frame[8:12])))
	bpp := int(binary.LittleEndian.Uint16(frame[14:16]))
	if width != s { return nil, fmt.Errorf("width mismatch %d", width) }
	if height != s*2 { return nil, fmt.Errorf("height mismatch %d", height) }
	if bpp != 32 { return nil, fmt.Errorf("bpp %d", bpp) }

	img := image.NewNRGBA(image.Rect(0, 0, s, s))
	px := hdrSize
	for y := s - 1; y >= 0; y-- {
		for x := 0; x < s; x++ {
			if px+4 > len(frame) { return nil, fmt.Errorf("truncated") }
			bl := frame[px]
			g := frame[px+1]
			r := frame[px+2]
			a := frame[px+3]
			img.Set(x, y, color.NRGBA{r, g, bl, a})
			px += 4
		}
	}
	return img, nil
}
