import sys,json,os
prd_path=sys.argv[1]; story_id=sys.argv[2]; raw_file=sys.argv[3]
raw=open(raw_file).read()
# Robust JSON-object scan, not a brace-depth-free regex -- see the sibling
# fix in the Step 4.2 story-ac-remediator above for why: a suggested AC's
# own verification snippet (e.g. `node -e "...{...}..."`) can contain
# literal braces inside a JSON string value, which a regex requiring ZERO
# braces in the whole match can never find. json.JSONDecoder.raw_decode
# respects real JSON nesting/escaping regardless of string contents.
decoder=json.JSONDecoder()
payload=None
idx=0
while True:
    start=raw.find('{', idx)
    if start==-1: break
    try:
        obj,end=decoder.raw_decode(raw, start)
        if isinstance(obj, dict) and 'new_acs' in obj:
            payload=obj
            break
        idx=end
    except json.JSONDecodeError:
        idx=start+1
if not payload: sys.exit(0)
new_acs=payload.get('new_acs',[])
if not new_acs: sys.exit(0)
with open(prd_path) as f: d=json.load(f)
added=0
for s in d['stories']:
    if s['id']==story_id:
        existing=[a.get('text','') if isinstance(a,dict) else str(a) for a in s.get('acceptanceCriteria',[])]
        for ac in new_acs:
            if ac and ac not in existing and len(existing)<24:
                s.setdefault('acceptanceCriteria',[]).append({'text':ac,'status':'pending'})
                added+=1
_tmp_prd_path=prd_path+'.tmp'
with open(_tmp_prd_path,'w') as f: json.dump(d,f,indent=2)
os.replace(_tmp_prd_path, prd_path)
print(added)
