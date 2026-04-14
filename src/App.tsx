import { Button } from "@/components/ui/button";

function App() {
  return (
    <div className="min-h-screen bg-zinc-950 text-white flex items-center justify-center">
      <div className="text-center space-y-6">
        <h1 className="text-2xl font-light text-zinc-200">HQ Installer</h1>
        <p className="text-sm text-zinc-500">Setting up your workspace...</p>
        <div className="flex gap-3 justify-center">
          <Button>Get Started</Button>
          <Button variant="secondary">Learn More</Button>
        </div>
      </div>
    </div>
  );
}

export default App;
