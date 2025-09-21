# Facebook Sponsored Post Blocker (Chrome Extension)

A lightweight Chrome extension that automatically detects and hides **sponsored posts** on Facebook.  
It works by reconstructing obfuscated "Sponsored" labels, so even when Facebook scrambles the letters, this extension still catches them.


## ✨ Features

- 🔍 Detects sponsored posts by reconstructing hidden "Sponsored" text.  
- 🚫 Hides sponsored posts from your feed (default behavior).  
- 🟨 Debug Mode: highlight sponsored posts instead of hiding them.
  <img width="705" height="598" alt="image" src="https://github.com/user-attachments/assets/85f1abe9-ea93-4587-b6ca-2f62fd67b296" />
- 📌 Optional banners: show a placeholder banner where the post was hidden.
  <img width="731" height="95" alt="image" src="https://github.com/user-attachments/assets/89a0e264-8476-468e-b1de-14516f401dd9" />



## ⚙️ Installation (Developer Mode)

1. Clone or download this repository.  
2. Open **Chrome** → go to `chrome://extensions/`.  
3. Enable **Developer mode** (top-right).  
4. Click **Load unpacked** and select the project folder.  
5. The extension will appear in your toolbar.


## 🔧 Usage

- By default, sponsored posts are hidden.  
- Click the extension icon to open the pop-up:  
  - **Enable/Disable** – master switch to toggle functionality.  
  - **Debug Mode** – highlights posts instead of hiding them.  
  - **Show Banner** – places a placeholder for the hidden sponsored posts.  


### ToDo:

- [ ] Update **Show Banner** option to add toggle the hidden post.

---

### ⚠️ Disclaimer

This extension is for **educational purposes only**.  
Facebook may change its DOM structure at any time, which could break detection.  
