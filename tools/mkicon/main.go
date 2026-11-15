// 生成 mdviewer 的 .ico 图标。
//
// 为什么用代码画而不是塞一张 PNG：ICO 需要多尺寸（16/32/48/64/128/256），
// 小尺寸要单独微调笔画粗细，否则任务栏里会糊成一团。
// 这里按尺寸分别为每个尺寸计算笔画宽度，保证 16px 下仍然可辨。
//
// 用法：go run tools/mkicon.go > 无参数，直接写 assets/mdviewer.ico
package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"os"
	"path/filepath"
)

// 尺寸按 Windows 实际会用到的档位排列
var sizes = []int{16, 24, 32, 48, 64, 128, 256}

// 配色：与编辑器界面一致（深色底 + 亮青强调色）
var (
	bgTop    = color.NRGBA{0x1E, 0x3A, 0x5F, 0xFF} // 上部深蓝
	bgBottom = color.NRGBA{0x0F, 0x1E, 0x33, 0xFF} // 下部更暗
	fg       = color.NRGBA{0x5A, 0xC8, 0xFA, 0xFF} // 亮青
)

func main() {
	// 直接产出 desktop/icon.ico：这是 mkres 的输入，也是 go:embed 的目标。
	// 单一来源，避免"两处图标不同步"这种低级问题。
	out := filepath.Join("..", "desktop", "icon.ico")
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "建目录失败:", err)
		os.Exit(1)
	}

	var images [][]byte
	for _, s := range sizes {
		img, err := renderIcon(s)
		if err != nil {
			fmt.Fprintf(os.Stderr, "渲染 %d 失败: %v\n", s, err)
			os.Exit(1)
		}
		// RT_ICON 资源必须是 DIB：老 API（ExtractAssociatedIcon、
		// Shell 缩略图缓存）遇到 PNG 帧会直接退回系统默认图标。
		dib, err := encodeDIBFrame(img, s)
		if err != nil {
			fmt.Fprintf(os.Stderr, "编码 DIB 失败 %d: %v\n", s, err)
			os.Exit(1)
		}
		images = append(images, dib)
	}

	ico, err := buildICO(sizes, images)
	if err != nil {
		fmt.Fprintln(os.Stderr, "组装 ICO 失败:", err)
		os.Exit(1)
	}
	if err := os.WriteFile(out, ico, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "写文件失败:", err)
		os.Exit(1)
	}
	fmt.Printf("已生成 %s (%d 字节, %d 个尺寸, DIB 帧)\n", out, len(ico), len(sizes))
}

// encodeDIBFrame 把图像编码成 ICO 内的 DIB 帧。
//
// 格式（自 Vista 起的标准 ICONIMAGE）：
//   BITMAPINFOHEADER（高度写两倍 = XOR 图 + AND 掩码）
//   XOR 数据：32 位 BGRA，自下而上逐行
//   AND 掩码：1 位/像素，自下而上，每行按 4 字节对齐
//
// 32 位色的 AND 掩码仍要写：系统只在部分路径上按 alpha 处理，
// 老路径会读掩码决定透明。全 0 表示"全部不透明"，由 alpha 负责柔边。
func encodeDIBFrame(src image.Image, s int) ([]byte, error) {
	b := src.Bounds()
	if b.Dx() != s || b.Dy() != s {
		return nil, fmt.Errorf("尺寸不符: %d != %d", b.Dx(), s)
	}

	var buf bytes.Buffer

	// BITMAPINFOHEADER = 40 字节
	binary.Write(&buf, binary.LittleEndian, uint32(40))          // biSize
	binary.Write(&buf, binary.LittleEndian, int32(s))            // biWidth
	binary.Write(&buf, binary.LittleEndian, int32(s*2))          // biHeight（两倍）
	binary.Write(&buf, binary.LittleEndian, uint16(1))           // biPlanes
	binary.Write(&buf, binary.LittleEndian, uint16(32))          // biBitCount
	binary.Write(&buf, binary.LittleEndian, uint32(0))           // biCompression=BI_RGB
	binary.Write(&buf, binary.LittleEndian, uint32(s*s*4))       // biSizeImage
	binary.Write(&buf, binary.LittleEndian, int32(0))            // biXPelsPerMeter
	binary.Write(&buf, binary.LittleEndian, int32(0))            // biYPelsPerMeter
	binary.Write(&buf, binary.LittleEndian, uint32(0))           // biClrUsed
	binary.Write(&buf, binary.LittleEndian, uint32(0))           // biClrImportant

	// XOR：BGRA，自下而上
	for y := s - 1; y >= 0; y-- {
		for x := 0; x < s; x++ {
			r, g, bl, a := src.At(b.Min.X+x, b.Min.Y+y).RGBA()
			buf.WriteByte(byte(bl >> 8))
			buf.WriteByte(byte(g >> 8))
			buf.WriteByte(byte(r >> 8))
			buf.WriteByte(byte(a >> 8))
		}
	}

	// AND 掩码：每行 (s+31)/32*4 字节
	rowBytes := ((s + 31) / 32) * 4
	for y := s - 1; y >= 0; y-- {
		row := make([]byte, rowBytes)
		for x := 0; x < s; x++ {
			_, _, _, a := src.At(b.Min.X+x, b.Min.Y+y).RGBA()
			if a>>8 == 0 {
				// 全透明：掩码置 1（被"挖掉"）
				row[x/8] |= 1 << (7 - uint(x%8))
			}
		}
		buf.Write(row)
	}

	return buf.Bytes(), nil
}

// renderIcon 画一个尺寸为 s 的图标，返回图像。
func renderIcon(s int) (image.Image, error) {
	img := image.NewNRGBA(image.Rect(0, 0, s, s))

	// 圆角半径按尺寸缩放。小尺寸（<=24）不给圆角：
	// 16px 下圆角只会啃掉四个像素，看起来是"缺角"而不是"圆角"。
	radius := cornerRadius(s)
	for y := 0; y < s; y++ {
		t := float64(y) / float64(s-1)
		row := lerpColor(bgTop, bgBottom, t)
		for x := 0; x < s; x++ {
			if insideRounded(float64(x)+0.5, float64(y)+0.5, float64(s), radius) {
				img.SetNRGBA(x, y, row)
			}
		}
	}

	// 主体：一个 M 字形（两竖 + 中间 V），用线段绘制。
	//
	// 16/24px 走单独的像素级路径：那个尺寸下浮点描边必然糊，
	// 必须按整数像素落笔，让每根笔画正好占 2 个像素宽。
	if s <= 24 {
		drawMSmall(img, s, fg)
	} else {
		strokeW := float64(s) * 0.13
		pad := float64(s) * 0.18
		top := pad
		bottom := float64(s) - pad
		left := pad
		right := float64(s) - pad
		mid := float64(s) / 2
		// V 的谷底：0.62 处比较自然，太深会显得下半部空
		vBottom := top + (bottom-top)*0.62

		lines := [][4]float64{
			{left, bottom, left, top},   // 左竖
			{right, bottom, right, top}, // 右竖
			{left, top, mid, vBottom},   // 左斜入
			{mid, vBottom, right, top},  // 右斜出
		}
		for _, ln := range lines {
			drawLine(img, ln[0], ln[1], ln[2], ln[3], strokeW, fg, s)
		}
	}

	// 不再画右下角小方块：M 本身已有足够辨识度，
	// 而方块在每个尺寸下都要重新算避让，反而成了杂音。
	// 需要点缀时宁可加大 V 谷底的圆角，也不加第二个形状。

	return img, nil
}

// lerpColor 在两色之间线性插值
func lerpColor(a, b color.NRGBA, t float64) color.NRGBA {
	mix := func(x, y uint8) uint8 {
		return uint8(float64(x)*(1-t) + float64(y)*t)
	}
	return color.NRGBA{mix(a.R, b.R), mix(a.G, b.G), mix(a.B, b.B), 0xFF}
}

// insideRounded 判断点是否在圆角矩形内
func insideRounded(x, y, size, radius float64) bool {
	if x < 0 || y < 0 || x >= size || y >= size {
		return false
	}
	// 四个角的圆形区域
	corners := [][2]float64{
		{radius, radius},
		{size - radius, radius},
		{radius, size - radius},
		{size - radius, size - radius},
	}
	inCornerZone := (x < radius || x > size-radius) && (y < radius || y > size-radius)
	if !inCornerZone {
		return true
	}
	for _, c := range corners {
		// 只判断与点同侧的那个角
		if (x-c[0])*(c[0]-radius) >= 0 && (y-c[1])*(c[1]-radius) >= 0 {
			dx, dy := x-c[0], y-c[1]
			return dx*dx+dy*dy <= radius*radius
		}
	}
	return true
}

// drawLine 用带抗锯齿的圆头线段绘制
func drawLine(img *image.NRGBA, x1, y1, x2, y2, w float64, c color.NRGBA, s int) {
	half := w / 2
	minX := int(minF(x1, x2) - half - 1)
	maxX := int(maxF(x1, x2) + half + 1)
	minY := int(minF(y1, y2) - half - 1)
	maxY := int(maxF(y1, y2) + half + 1)

	for y := minY; y <= maxY; y++ {
		for x := minX; x <= maxX; x++ {
			px, py := float64(x)+0.5, float64(y)+0.5
			d := distToSegment(px, py, x1, y1, x2, y2)
			if d <= half {
				blendPixel(img, x, y, c, 1.0, s)
			} else if d <= half+1 {
				// 边缘做一像素过渡，消除锯齿
				blendPixel(img, x, y, c, half+1-d, s)
			}
		}
	}
}

// drawMSmall 是 16/24px 的专用 M 绘制。
//
// 小尺寸不能用浮点描边：抗锯齿会把 2px 的笔画糊成 3px 的灰带，
// 两条竖线之间就再也分不开。这里直接按像素填，笔画宽度按尺寸取整：
// 16px 用 2px、24px 用 3px。比例固定，不随尺寸漂移。
func drawMSmall(img *image.NRGBA, s int, c color.NRGBA) {
	w := 2
	if s >= 24 {
		w = 3
	}
	edge := 2 // 四周留白（像素）

	x0 := edge
	x1 := s - edge - w
	y0 := edge
	y1 := s - edge - w

	put := func(px, py int) {
		for dy := 0; dy < w; dy++ {
			for dx := 0; dx < w; dx++ {
				X, Y := px+dx, py+dy
				if X >= 0 && Y >= 0 && X < s && Y < s {
					img.SetNRGBA(X, Y, c)
				}
			}
		}
	}

	// 两竖
	for y := y0; y <= y1; y++ {
		put(x0, y)
		put(x1, y)
	}

	// 中间 V：从左上到中点、中点再到右上，逐列推进
	midX := s/2 - w/2
	vBottomY := y0 + (y1-y0)*3/5
	spanLeft := midX - x0
	for i := 0; i <= spanLeft; i++ {
		x := x0 + i
		y := y0
		if spanLeft > 0 {
			y = y0 + (vBottomY-y0)*i/spanLeft
		}
		put(x, y)
	}
	spanRight := x1 - midX
	for i := 0; i <= spanRight; i++ {
		x := midX + i
		y := vBottomY
		if spanRight > 0 {
			y = vBottomY - (vBottomY-y0)*i/spanRight
		}
		put(x, y)
	}
}

// cornerRadius 是唯一的圆角半径定义，绘制与裁剪必须共用，
// 否则笔画会被画到圆角外面又被裁掉，边缘出现毛刺。
func cornerRadius(s int) float64 {
	if s <= 24 {
		return 0
	}
	return float64(s) * 0.16
}

// blendPixel 按 alpha 混合到画布，并裁剪到圆角外形
func blendPixel(img *image.NRGBA, x, y int, c color.NRGBA, alpha float64, s int) {
	if x < 0 || y < 0 || x >= s || y >= s {
		return
	}
	if !insideRounded(float64(x)+0.5, float64(y)+0.5, float64(s), cornerRadius(s)) {
		return
	}
	if alpha <= 0 {
		return
	}
	if alpha > 1 {
		alpha = 1
	}
	dst := img.NRGBAAt(x, y)
	img.SetNRGBA(x, y, color.NRGBA{
		R: uint8(float64(dst.R)*(1-alpha) + float64(c.R)*alpha),
		G: uint8(float64(dst.G)*(1-alpha) + float64(c.G)*alpha),
		B: uint8(float64(dst.B)*(1-alpha) + float64(c.B)*alpha),
		A: 0xFF,
	})
}

// distToSegment 点到线段的最短距离
func distToSegment(px, py, x1, y1, x2, y2 float64) float64 {
	dx, dy := x2-x1, y2-y1
	if dx == 0 && dy == 0 {
		return hypot(px-x1, py-y1)
	}
	t := ((px-x1)*dx + (py-y1)*dy) / (dx*dx + dy*dy)
	if t < 0 {
		t = 0
	} else if t > 1 {
		t = 1
	}
	return hypot(px-(x1+t*dx), py-(y1+t*dy))
}

func hypot(a, b float64) float64 {
	return sqrt(a*a + b*b)
}

func sqrt(v float64) float64 {
	if v <= 0 {
		return 0
	}
	// 牛顿迭代足够，避免引入 math 只为一次开方
	x := v
	for i := 0; i < 24; i++ {
		x = 0.5 * (x + v/x)
	}
	return x
}

func minF(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

func maxF(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

// buildICO 按 ICO 格式组装：目录项 + 各尺寸 PNG 数据。
// Vista 起 ICO 允许内嵌 PNG，256px 必须用 PNG，其余也用 PNG 更省体积。
func buildICO(sizes []int, images [][]byte) ([]byte, error) {
	if len(sizes) != len(images) {
		return nil, fmt.Errorf("尺寸与图像数量不匹配")
	}

	var buf bytes.Buffer
	// ICONDIR：保留(2) + 类型(2, 1=icon) + 数量(2)
	binary.Write(&buf, binary.LittleEndian, uint16(0))
	binary.Write(&buf, binary.LittleEndian, uint16(1))
	binary.Write(&buf, binary.LittleEndian, uint16(len(sizes)))

	// 数据区起点 = 6 + 16*count
	offset := uint32(6 + 16*len(sizes))
	for i, s := range sizes {
		dim := byte(s)
		if s >= 256 {
			dim = 0 // 256 在 ICO 里用 0 表示
		}
		buf.WriteByte(dim) // 宽
		buf.WriteByte(dim) // 高
		buf.WriteByte(0)   // 调色板数
		buf.WriteByte(0)   // 保留
		binary.Write(&buf, binary.LittleEndian, uint16(1))  // 色彩平面
		binary.Write(&buf, binary.LittleEndian, uint16(32)) // 位深
		binary.Write(&buf, binary.LittleEndian, uint32(len(images[i])))
		binary.Write(&buf, binary.LittleEndian, offset)
		offset += uint32(len(images[i]))
	}

	for _, img := range images {
		buf.Write(img)
	}
	return buf.Bytes(), nil
}
