import AppKit

let size = NSSize(width: 1024, height: 1024)
let image = NSImage(size: size)
image.lockFocus()
NSGradient(colors: [NSColor(red: 0.04, green: 0.64, blue: 0.49, alpha: 1),
                    NSColor(red: 0.05, green: 0.16, blue: 0.24, alpha: 1)])!.draw(in: NSRect(origin: .zero, size: size), angle: -45)
let mark = NSImage(systemSymbolName: "chart.bar.xaxis", accessibilityDescription: nil)!
let config = NSImage.SymbolConfiguration(pointSize: 470, weight: .semibold)
mark.withSymbolConfiguration(config)!.draw(in: NSRect(x: 230, y: 230, width: 564, height: 564))
image.unlockFocus()
let output = URL(fileURLWithPath: CommandLine.arguments[1])
let data = image.tiffRepresentation.flatMap(NSBitmapImageRep.init)?.representation(using: .png, properties: [:])!
try data?.write(to: output)
