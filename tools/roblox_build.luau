-- 在 Roblox Studio 里按 bin/roblox.mjs 写出的数据拼场景（只用 Part / WedgePart，不用 Union）。
-- 用法：预览服务器起着（node bin/serve.mjs 5178），HttpService.HttpEnabled 打开；把 BASE、FIRST、LAST 填好，在命令栏或 MCP 的 execute_luau 里跑。
-- 一次拼 [FIRST, LAST] 这几块（每块约 4000 个零件），重复跑会跳过已经拼过的块（根 Model 的属性 Built_<k>）。
local BASE = "http://localhost:5178/work/sc/full/roblox/"
local FIRST, LAST = 0, 0
local H = game:GetService("HttpService")
local CS = game:GetService("CollectionService")
local idx = H:JSONDecode(H:GetAsync(BASE .. "index.json"))
local root = workspace:FindFirstChild(idx.root)
if not root then
	root = Instance.new("Model")
	root.Name = idx.root
	root:SetAttribute("Scale", idx.scale)
	root:SetAttribute("Note", "SVG3D 逆向重建，Roblox 基本型；5 stud = 1.7 m")
	root.Parent = workspace
end
local colors, mats = {}, {}
for i, c in ipairs(idx.colors) do colors[i - 1] = Color3.fromHex(c) end
for i, m in ipairs(idx.materials) do mats[i - 1] = Enum.Material[m] end
local SHAPE = { [0] = Enum.PartType.Block, [2] = Enum.PartType.Cylinder, [3] = Enum.PartType.Ball }
local cache = {}
-- 路径 "Structure/BigMeshGroup_50_-34/物体/0" → 实例（没有就建：前两层 Folder，再往下 Model）
local function ensure(path)
	local hit = cache[path]
	if hit then return hit end
	local parent, acc = root, nil
	for i, seg in ipairs(string.split(path, "/")) do
		acc = acc and (acc .. "/" .. seg) or seg
		local inst = cache[acc]
		if not inst then
			inst = parent:FindFirstChild(seg)
			if not inst then
				inst = Instance.new(i <= 2 and "Folder" or "Model")
				inst.Name = seg
				inst.Parent = parent
			end
			cache[acc] = inst
		end
		parent = inst
	end
	return parent
end
local built, t0 = 0, os.clock()
for k = FIRST, math.min(LAST, idx.chunks - 1) do
	if not root:GetAttribute("Built_" .. k) then
		local c = H:JSONDecode(H:GetAsync(BASE .. "chunk_" .. k .. ".json"))
		for _, p in ipairs(c.parts) do
			local shape = p[2]
			local part = shape == 1 and Instance.new("WedgePart") or Instance.new("Part")
			if shape ~= 1 then part.Shape = SHAPE[shape] end
			part.Anchored = true
			part.Size = Vector3.new(p[3], p[4], p[5])
			part.CFrame = CFrame.new(p[6], p[7], p[8], p[9], p[10], p[11], p[12], p[13], p[14], p[15], p[16], p[17])
			part.Color = colors[p[18]]
			part.Material = mats[p[19]]
			part.Transparency = p[20]
			part.CanCollide = p[21] == 1
			if p[20] >= 1 then part.CastShadow = false end
			part.Name = p[22]
			part.Parent = ensure(c.paths[p[1] + 1])
			built += 1
		end
		-- 语义：属性与标签（单块的物体是零件本身，多块的是 Model）
		for _, a in ipairs(c.attrs) do
			local inst = root
			for _, seg in ipairs(string.split(a[1], "/")) do inst = inst and inst:FindFirstChild(seg) end
			if inst then
				for key, v in pairs(a[2]) do inst:SetAttribute(key, v) end
				for _, tag in ipairs(a[3]) do CS:AddTag(inst, tag) end
			end
		end
		root:SetAttribute("Built_" .. k, true)
	end
end
return { built = built, seconds = os.clock() - t0, chunks = idx.chunks }
