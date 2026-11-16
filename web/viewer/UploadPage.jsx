// Landing page for /viewer/: open a demo from your own computer. Added by viewer/patch.mjs.
import Uploader from "./Index/Uploader/Uploader";

export function UploadPage() {
  return (
    <div className="cs2panel-upload">
      <p><a href="/demos">← Back to demos</a></p>
      <h1>Watch your own demo in 2D</h1>
      <p className="cs2panel-note">
        Pick a CS2 demo from your computer. It is opened right here in your browser and is not uploaded to the server.
      </p>
      <Uploader />
    </div>
  );
}
